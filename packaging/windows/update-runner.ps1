param([Parameter(Mandatory=$true)][string]$Plan, [switch]$ValidateOnly, [switch]$TestMode)
$ErrorActionPreference = 'Stop'
$job = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Plan))
$planData = $null
$keepPending = $false
$pathsValidated = $false
$installerCleanup = $null
function Write-Json([string]$Path, $Value) {
  $text = $Value | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}
function Verify-Installer {
  if ((Get-FileHash -LiteralPath $planData.installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $planData.sha256) { throw 'Installer SHA-256 mismatch.' }
  $info = (Get-Item -LiteralPath $planData.installer).VersionInfo
  $version = if ($info.ProductVersion) { $info.ProductVersion } else { $info.FileVersion }
  if ($info.ProductName -ne 'SapLink' -or $version -notmatch ('^' + [regex]::Escape($planData.version) + '(?:\.0)?$')) {
    throw 'Installer product or version mismatch.'
  }
}
try {
  $planData = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($planData.schema_version -ne 1 -or $planData.id -notmatch '^[a-f0-9-]{36}$' -or
      $planData.version -notmatch '^\d+\.\d+\.\d+$' -or $planData.sha256 -notmatch '^[a-f0-9]{64}$' -or
      $planData.architecture -notin @('x64','arm64') -or $planData.mode -notin @('ui','service','stopped')) { throw 'Invalid update plan.' }
  $configRoot = [IO.Path]::GetFullPath($planData.config_directory).TrimEnd('\')
  $installRoot = [IO.Path]::GetFullPath($planData.install_directory).TrimEnd('\')
  $updatesRoot = Join-Path $configRoot 'updates'
  if (!$job.StartsWith($updatesRoot + '\job-', [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetDirectoryName($job) -ne $updatesRoot -or
      [IO.Path]::GetFullPath($planData.installer) -ne (Join-Path $job 'installer.exe') -or
      $job.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe update paths.' }
  $directory = $job
  while ($directory -and $directory.Length -ge $configRoot.Length) {
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update directories must not be links.' }
    $directory = [IO.Path]::GetDirectoryName($directory)
  }
  if ($TestMode -and $planData.mode -ne 'stopped') { throw 'Isolated tests must not restart applications.' }
  $registration = if ($TestMode) { 'HKCU:\Software\SapLinkInstallerTest' } else { 'HKCU:\Software\SapLink' }
  $registered = (Get-ItemProperty -LiteralPath $registration).InstallDir
  if (!$registered -or [IO.Path]::GetFullPath($registered).TrimEnd('\') -ne $installRoot) { throw 'Registered installation does not match.' }
  $manifest = Get-Content -LiteralPath (Join-Path $installRoot 'install-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $build = Get-Content -LiteralPath (Join-Path $installRoot 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.app_id -ne 'org.saplink.desktop' -or $build.architecture -ne $planData.architecture -or
      [version]$planData.version -le [version]$manifest.version) { throw 'Update target must be a newer version of this installation.' }
  foreach ($port in @($planData.mcp_port, $planData.ui_port)) {
    if ($null -ne $port -and ($port -isnot [int] -or $port -lt 1 -or $port -gt 65535)) { throw 'Invalid restart port.' }
  }
  if (($planData.mode -eq 'service' -and !$planData.mcp_port) -or ($planData.mode -eq 'ui' -and !$planData.ui_port)) { throw 'Missing restart port.' }
  $pathsValidated = $true
  Verify-Installer
  if ($ValidateOnly) { Write-Output 'Update plan and installer validated; nothing installed.'; exit 0 }
  Write-Json (Join-Path $job 'ready.json') @{ id=$planData.id }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $committed = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    $commitPath = Join-Path $job 'commit.json'
    if (Test-Path -LiteralPath $commitPath) {
      try { $committed = ((Get-Content -LiteralPath $commitPath -Raw | ConvertFrom-Json).id -eq $planData.id) } catch { }
      if ($committed) { break }
    }
    Start-Sleep -Milliseconds 200
  }
  if (!$committed) { throw 'The application did not commit the update. Nothing was installed.' }
  $executables = @('runtime\node.exe','bin\saplink.exe','bin\saplink-gui.exe') | ForEach-Object { Join-Path $installRoot $_ }
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  do {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='saplink.exe' OR Name='saplink-gui.exe'" |
      Where-Object { $_.ExecutablePath -and $executables -contains $_.ExecutablePath })
    if (!$running.Count) { break }
    Start-Sleep -Milliseconds 300
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($running.Count) { throw 'SapLink did not exit gracefully in time. No process was killed and installation did not start.' }
  Verify-Installer
  $env:SAPLINK_CONFIG_DIR = $configRoot
  # NSIS requires /D to be last and its value to be unquoted, including paths with spaces.
  $installer = Start-Process -FilePath $planData.installer -ArgumentList ('/S /D=' + $installRoot) -WindowStyle Hidden -PassThru
  if (!$installer.WaitForExit(600000)) { $keepPending = $true; throw 'Installer outcome is unknown; inspect the still-running installer before retrying.' }
  if ($installer.ExitCode -ne 0) { throw "Installer returned exit code $($installer.ExitCode). Reopen or repair SapLink; configuration is preserved." }
  $installed = Get-Content -LiteralPath (Join-Path $installRoot 'install-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($installed.app_id -ne 'org.saplink.desktop' -or $installed.version -ne $planData.version) { throw 'Could not verify the installed version.' }
  # Installation is verified. Clean up before restart, which may fail independently.
  # NSIS can briefly retain the executable after its parent process has exited.
  $installerCleanup = @{ status='failed'; path=$planData.installer }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      if (Test-Path -LiteralPath $planData.installer) { Remove-Item -LiteralPath $planData.installer -ErrorAction Stop }
      $installerCleanup.status = 'deleted'
      break
    } catch {
      if ($attempt -lt 9) { Start-Sleep -Milliseconds 300 }
    }
  }
  if ($installerCleanup.status -eq 'failed') {
    $installerCleanup.message = 'Installation succeeded, but installer cleanup failed. Delete this file manually after the installer exits.'
  }
  $restart = 'not_requested'
  if ($planData.mode -eq 'ui') {
    if ($planData.mcp_port) { $env:SAPLINK_RESTART_MCP_PORT = [string]$planData.mcp_port }
    $env:SAPLINK_UI_PORT = [string]$planData.ui_port
    Start-Process -FilePath (Join-Path $installRoot 'bin\saplink-gui.exe') -WindowStyle Hidden | Out-Null
    $restart = 'ui_launched'
  } elseif ($planData.mode -eq 'service') {
    $output = & (Join-Path $installRoot 'bin\saplink.exe') service start --port $planData.mcp_port --json
    if ($LASTEXITCODE -ne 0 -or ($output | ConvertFrom-Json).data.state -ne 'running') { throw 'Installed successfully, but background service restart was not confirmed.' }
    $restart = 'service_running'
  }
  $result = @{ status='installed'; version=$planData.version; restart=$restart; installer_cleanup=$installerCleanup; finished_at=[DateTime]::UtcNow.ToString('o') }
  Write-Json (Join-Path $job 'result.json') $result
  Write-Json (Join-Path $configRoot 'update-install-result.json') $result
} catch {
  if ($ValidateOnly) { Write-Error $_.Exception.Message; exit 1 }
  $result = @{ status=$(if ($keepPending) { 'unknown' } else { 'failed' }); version=$planData.version; message=$_.Exception.Message; installer_cleanup=$installerCleanup; finished_at=[DateTime]::UtcNow.ToString('o') }
  Write-Json (Join-Path $job 'result.json') $result
  if ($pathsValidated) { Write-Json (Join-Path $configRoot 'update-install-result.json') $result }
  exit 1
} finally {
  # Only remove this job's marker. A timed-out installer must block duplicate attempts.
  if (!$keepPending -and $updatesRoot -and !$ValidateOnly) {
    $pending = Join-Path $updatesRoot 'pending.json'
    if (Test-Path -LiteralPath $pending) {
      try {
        if ((Get-Content -LiteralPath $pending -Raw | ConvertFrom-Json).id -eq $planData.id) { Remove-Item -LiteralPath $pending }
      } catch { }
    }
  }
}
