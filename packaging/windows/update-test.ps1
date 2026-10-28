param([switch]$ShowInstallProgress)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$compiler = Join-Path $repository '.saplink\installer-cache\nsis-3.12\makensis.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Build the Windows installer once to populate the pinned NSIS cache.' }
$testRunId = [Guid]::NewGuid().ToString('N')
$registration = 'HKCU:\Software\SapLinkInstallerTest-' + $testRunId
if (Test-Path -LiteralPath $registration) { throw 'An installer test registration already exists; finish that test before running updater checks.' }
$root = Join-Path $env:TEMP ('SapLink-update-test-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $root 'stage'
$installed = Join-Path $root 'installed app'
$config = Join-Path $root 'config'
$job = Join-Path $config 'updates\job-native'
New-Item -ItemType Directory -Path $stage,$installed,$job -Force | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
function Save-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 5), $utf8) }
try {
  # Compile both launcher modes and verify the detached bridge with a harmless helper.
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
  & $csc /nologo /target:exe /platform:anycpu "/out:$root\bridge.exe" (Join-Path $PSScriptRoot 'Launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Console launcher compilation failed.' }
  & $csc /nologo /target:winexe /platform:anycpu /codepage:65001 /define:GUI /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32manifest:$PSScriptRoot\GuiLauncher.manifest" "/out:$root\gui.exe" (Join-Path $PSScriptRoot 'Launcher.cs') (Join-Path $PSScriptRoot 'GuiLauncher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'GUI launcher compilation failed.' }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'GuiLauncher.config') -Destination (Join-Path $root 'gui.exe.config')
  $bridgeScript = Join-Path $root 'update-runner.ps1'
  $bridgePlan = Join-Path $root 'plan.json'
  [IO.File]::WriteAllText($bridgeScript, 'param([string]$Plan) [IO.File]::WriteAllText($Plan + ''.ran'', ''ok'')', $utf8)
  & (Join-Path $root 'bridge.exe') --internal-update-run $bridgeScript $bridgePlan
  if ($LASTEXITCODE -ne 0) { throw 'Detached updater bridge failed.' }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath ($bridgePlan + '.ran')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (!(Test-Path -LiteralPath ($bridgePlan + '.ran'))) { throw 'Hidden helper did not run.' }

  & $csc /nologo /target:winexe /platform:anycpu /define:GUI "/out:$stage\installer-host.exe" (Join-Path $PSScriptRoot 'Launcher.cs') (Join-Path $PSScriptRoot 'InstallerControlHost.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Installer control host compilation failed.' }
  $probeScript = Join-Path $root 'console probe.ps1'
  $probeResult = Join-Path $root 'console result.txt'
  $probeSource = @'
param([string]$Report)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NativeConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
[IO.File]::WriteAllText($Report, [NativeConsoleProbe]::GetConsoleWindow().ToInt64().ToString())
exit 37
'@
  [IO.File]::WriteAllText($probeScript, $probeSource, $utf8)
  $probe = Start-Process -FilePath (Join-Path $stage 'installer-host.exe') -ArgumentList @(('"' + $probeScript + '"'), '-Report', ('"' + $probeResult + '"')) -WindowStyle Hidden -Wait -PassThru
  if ($probe.ExitCode -ne 37 -or (Get-Content -LiteralPath $probeResult -Raw) -ne '0') { throw 'Installer host created a console, lost arguments or failed to propagate the exit code.' }

  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'installer-control.ps1') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repository '.saplink\installer-build\stage-arm64\saplink.ico') -Destination $stage
  Save-Json (Join-Path $stage 'build-info.json') @{ architecture='x64'; app_version='9.0.0' }
  [IO.File]::WriteAllText((Join-Path $stage 'new-payload.txt'), 'new', $utf8)
  Save-Json (Join-Path $stage 'install-manifest.json') @{ schema_version=1; app_id='org.saplink.desktop'; version='9.0.0'; architecture='x64';
    files=@('installer-host.exe','installer-control.ps1','saplink.ico','build-info.json','new-payload.txt'); directories=@() }
  $installer = Join-Path $job 'installer.exe'
  & $compiler /V1 /INPUTCHARSET UTF8 /DAPP_VERSION=9.0.0 /DTARGET_ARCH=x64 /DTEST_MODE "/DTEST_RUN_ID=$testRunId" "/DSTAGE_DIR=$stage" "/DOUTPUT_FILE=$installer" (Join-Path $PSScriptRoot 'installer.nsi')
  if ($LASTEXITCODE -ne 0) { throw 'Isolated installer compilation failed.' }
  Save-Json (Join-Path $installed 'install-manifest.json') @{ schema_version=1; app_id='org.saplink.desktop'; version='1.0.0'; architecture='x64'; files=@('old-payload.txt'); directories=@() }
  Save-Json (Join-Path $installed 'build-info.json') @{ architecture='x64'; app_version='1.0.0' }
  [IO.File]::WriteAllText((Join-Path $installed 'old-payload.txt'), 'old', $utf8)
  [IO.File]::WriteAllText((Join-Path $config 'keep-config.txt'), 'retained', $utf8)
  New-Item -Path $registration -Force | Out-Null
  Set-ItemProperty -LiteralPath $registration -Name InstallDir -Value $installed
  $id = [Guid]::NewGuid().ToString()
  $plan = @{ schema_version=1; id=$id; install_directory=$installed; installer=$installer; config_directory=$config;
    architecture='x64'; version='9.0.0'; sha256=('0' * 64); mode='stopped'; show_install_progress=[bool]$ShowInstallProgress }
  $planPath = Join-Path $job 'plan.json'
  Save-Json $planPath $plan
  $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'update-runner.ps1') -Plan $planPath -TestMode -TestRunId $testRunId -ValidateOnly 2>&1 | Out-Null
  $badHashExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($badHashExit -eq 0 -or (Get-Content (Join-Path $installed 'old-payload.txt') -Raw) -ne 'old') { throw 'Invalid hash was not safely rejected.' }
  $plan.sha256 = (Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant()
  Save-Json $planPath $plan
  Save-Json (Join-Path $config 'updates\pending.json') @{ id=$id }
  Save-Json (Join-Path $job 'commit.json') @{ id=$id }
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'update-runner.ps1') -Plan $planPath -TestMode -TestRunId $testRunId
  if ($LASTEXITCODE -ne 0) { throw ('Native update failed: ' + (Get-Content (Join-Path $job 'result.json') -Raw)) }
  $result = Get-Content (Join-Path $job 'result.json') -Raw | ConvertFrom-Json
  if ($result.status -ne 'installed' -or (Get-Content (Join-Path $installed 'install-manifest.json') -Raw | ConvertFrom-Json).version -ne '9.0.0') { throw 'Installed version not confirmed.' }
  if (!(Test-Path (Join-Path $installed 'new-payload.txt')) -or (Test-Path (Join-Path $installed 'old-payload.txt'))) { throw 'Owned payload replacement failed.' }
  if ((Get-Content (Join-Path $config 'keep-config.txt') -Raw) -ne 'retained' -or (Test-Path (Join-Path $config 'updates\pending.json'))) { throw 'Configuration preservation or pending cleanup failed.' }
  if ((Test-Path -LiteralPath $installer) -or $result.installer_cleanup.status -ne 'deleted') { throw 'Verified update did not remove its installer or report cleanup.' }
  Write-Host "Native updater checks passed: launcher compilation, detached helper, hash rejection, automatic upgrade with spaces, console-free control host, version verification and configuration preservation. Fixture: $root"
} finally {
  if (Test-Path -LiteralPath (Join-Path $installed 'Uninstall.exe')) {
    $env:SAPLINK_CONFIG_DIR = $config
    $uninstaller = Start-Process -FilePath (Join-Path $installed 'Uninstall.exe') -ArgumentList @('/S', ('_?=' + $installed)) -WindowStyle Hidden -Wait -PassThru
    if ($uninstaller.ExitCode -ne 0) { Write-Warning 'Isolated test uninstall did not complete; inspect the fixture before running it again.' }
  }
  # The fixture uses a dedicated test registry key; never modify the real product key.
  if (Test-Path -LiteralPath $registration) {
    if ((Get-ItemProperty -LiteralPath $registration).InstallDir -eq $installed) { Remove-Item -LiteralPath $registration -Recurse }
  }
}
