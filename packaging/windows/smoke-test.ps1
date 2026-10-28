param([ValidateSet('x64','arm64')][string]$Architecture = 'arm64')
$ErrorActionPreference = 'Stop'
$testRunId = [Guid]::NewGuid().ToString('N')
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stage = Join-Path $repository ('.saplink\installer-build\stage-' + $Architecture)
$compiler = Join-Path $repository '.saplink\installer-cache\nsis-3.12\makensis.exe'
$version = (Get-Content (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).version
$testOutput = Join-Path $repository '.saplink\installer-build\tests'
New-Item -ItemType Directory -Path $testOutput -Force | Out-Null
$installer = Join-Path $testOutput "SapLink-$version-win-$Architecture-test-setup.exe"
$iconName = 'saplink-' + (Get-FileHash -LiteralPath (Join-Path $stage 'saplink.ico')).Hash.Substring(0,12).ToLowerInvariant() + '.ico'
& $compiler /V2 /INPUTCHARSET UTF8 "/DAPP_VERSION=$version" "/DTARGET_ARCH=$Architecture" "/DSTAGE_DIR=$stage" "/DOUTPUT_FILE=$installer" "/DICON_FILENAME=$iconName" /DTEST_MODE "/DTEST_RUN_ID=$testRunId" (Join-Path $PSScriptRoot 'installer.nsi')
if ($LASTEXITCODE -ne 0) { throw 'Test installer compilation failed.' }

$testRoot = Join-Path $env:TEMP ('SapLink Installer Test ' + [Guid]::NewGuid().ToString('N'))
$install = Join-Path $testRoot '安装目录 with spaces'
$config = Join-Path $testRoot 'private-config'
$working = Join-Path $testRoot 'unrelated terminal directory'
$keyName = 'Software\SapLinkInstallerTest-' + $testRunId
$registry = [Microsoft.Win32.Registry]::CurrentUser
if ($registry.OpenSubKey($keyName)) { throw 'Installer test registry already exists; preserve it for inspection before rerunning.' }
$actualEnvironment = $registry.OpenSubKey('Environment')
$actualPath = $actualEnvironment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$actualEnvironment.Dispose()
$oldPath = $env:Path
$oldConfig = $env:SAPLINK_CONFIG_DIR
$oldLogs = $env:SAPLINK_LOG_DIR
New-Item -ItemType Directory -Path $config,$working -Force | Out-Null
Copy-Item -LiteralPath $installer -Destination (Join-Path $testRoot 'installer.exe')
$installer = Join-Path $testRoot 'installer.exe'
$env:SAPLINK_CONFIG_DIR = $config
$env:SAPLINK_LOG_DIR = Join-Path $testRoot 'logs'
$originalTestPath = '%USERPROFILE%\Existing Tool;C:\Unrelated'
$environment = $registry.CreateSubKey($keyName + '\Environment')
$environment.SetValue('Path', $originalTestPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
$environment.Dispose()

function Run-Installer([string]$Directory = $install) {
  Write-Host "Running isolated installer at $([DateTime]::Now.ToString('T'))"
  $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$Directory" -WindowStyle Hidden -Wait -PassThru
  return $process.ExitCode
}
function Assert-True([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Cli-Json([string[]]$Arguments) {
  $text = & (Join-Path $install 'bin\saplink.exe') @Arguments --json
  if ($LASTEXITCODE -ne 0) { throw 'Installed CLI command failed.' }
  return ($text | ConvertFrom-Json)
}
try {
  # A previous crash may leave a lease. Installation must accept a verified exited owner.
  $unusedOwner = 2147483647
  if (Get-CimInstance Win32_Process -Filter "ProcessId=$unusedOwner") { throw 'Test PID unexpectedly exists.' }
  $staleRecord = @{pid=$unusedOwner;started_at='2000-01-01T00:00:00Z';nonce='installer-stale-test'} | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $config 'runtime.lock'), $staleRecord, [Text.UTF8Encoding]::new($false))
  Write-Host "Installing ($Architecture) into $install"
  Assert-True ((Run-Installer) -eq 0) 'Silent install failed.'
  & {
    Assert-True (Test-Path -LiteralPath (Join-Path $install 'runtime\java\bin\java.exe')) 'Bundled RFC Java is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $install 'runtime\java\legal\java.base\LICENSE')) 'Java legal notices are missing.'
    & (Join-Path $install 'runtime\java\bin\java.exe') -version
    Assert-True ($LASTEXITCODE -eq 0) 'Installed private Java cannot start.'
    $rfcModule = Join-Path $install 'app\dist\rfc-environment.js'
    $discoveryScript = Join-Path $testRoot 'check-rfc-environment.mjs'
    $discoverySource = @'
import {pathToFileURL} from 'node:url';
const m=await import(pathToFileURL(process.argv[2]).href);
const r=await m.checkRfcEnvironment({directory:process.argv[3],env:{JAVA_HOME:'invalid',SAPLINK_RFC_JAVA:'invalid',SAPLINK_RFC_JCO_JAR:'invalid',JAVA_TOOL_OPTIONS:'-invalid'}});
console.log(JSON.stringify({source:r.detected.java?.source,managed:r.managed,healthy:r.healthy,versions:r.versions}));
'@
    [IO.File]::WriteAllText($discoveryScript, $discoverySource, [Text.UTF8Encoding]::new($false))
    $javaDiscovery = & (Join-Path $install 'runtime\node.exe') $discoveryScript $rfcModule $config
    Assert-True ($LASTEXITCODE -eq 0) 'Installed RFC discovery failed.'
    $discovered = $javaDiscovery | ConvertFrom-Json
    Assert-True ($discovered.source -eq 'bundled' -and $discovered.managed -and $discovered.healthy -and $discovered.versions.architecture -eq 'amd64') 'The installed complete RFC runtime must load without any system configuration.'
  }
  $secondInstall = Join-Path $testRoot 'second application copy'
  $manifestHash = (Get-FileHash -LiteralPath (Join-Path $install 'install-manifest.json')).Hash
  Assert-True ((Run-Installer -Directory $secondInstall) -eq 15) 'A second installation directory was not rejected.'
  Assert-True (!(Test-Path -LiteralPath $secondInstall)) 'Rejected installation created a second application directory.'
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $install 'install-manifest.json')).Hash -eq $manifestHash) 'Rejected installation changed the original payload.'
  $registered = $registry.OpenSubKey($keyName)
  try { Assert-True ($registered.GetValue('InstallDir') -eq $install) 'Rejected installation changed the registered directory.' }
  finally { $registered.Dispose() }
  $environment = $registry.OpenSubKey($keyName + '\Environment')
  $installedPath = $environment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  Assert-True ($installedPath -eq ($originalTestPath + ';' + (Join-Path $install 'bin'))) 'PATH content or variable expansion was changed incorrectly.'
  Assert-True ($environment.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) 'PATH registry value type changed.'
  $environment.Dispose()
  $shell = New-Object -ComObject WScript.Shell
  foreach ($link in @('test-shortcuts\Desktop\SapLink.lnk','test-shortcuts\Start Menu\SapLink\SapLink 管理界面.lnk')) {
    $shortcut = $shell.CreateShortcut((Join-Path $install $link))
    Assert-True ($shortcut.TargetPath -eq (Join-Path $install 'bin\saplink-gui.exe')) 'GUI shortcut target is incorrect.'
    Assert-True ($shortcut.IconLocation -eq ((Join-Path $install $iconName) + ',0')) 'Shortcut does not use the content-addressed icon.'
  }
  $env:Path = (Join-Path $install 'bin') + ';' + $oldPath
  Push-Location $working
  try {
    Assert-True ((Get-Command saplink).Source -eq (Join-Path $install 'bin\saplink.exe')) 'Command did not resolve from an unrelated directory.'
    $reportedVersion = & saplink --version
    Assert-True ($reportedVersion -eq $version) 'Installed launcher reported the wrong version.'
    $state = Cli-Json @('status')
    Assert-True ($state.data.service.state -eq 'stopped') 'Unexpected service state in isolated configuration.'
    $created = Cli-Json @('token','create','--out','relative token.json')
    Assert-True (Test-Path -LiteralPath (Join-Path $working 'relative token.json')) 'Launcher did not preserve caller working directory/arguments.'
    Assert-True ($created.data.token_file -eq (Join-Path $working 'relative token.json')) 'Relative token output path resolved incorrectly.'
  } finally { Pop-Location }
  $configHash = (Get-FileHash (Join-Path $config 'config.json')).Hash
  Set-Content -LiteralPath (Join-Path $install 'keep-user-file.txt') -Value 'Preserve unknown files' -Encoding UTF8
  $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $portProbe.Start(); $port = $portProbe.LocalEndpoint.Port; $portProbe.Stop()
  $started = Cli-Json @('service','start','--port',[string]$port)
  Assert-True ($started.data.state -eq 'running') 'Installed background service did not start.'
  $cacheCleared = Cli-Json @('cache','clear')
  Assert-True ($cacheCleared.data.cleared_sessions -eq 0 -and $cacheCleared.data.retained_write_requests -eq 0) 'Installed cache cleanup failed.'
  Assert-True ((Cli-Json @('service','status')).data.pid -eq $started.data.pid) 'Cache cleanup restarted the service.'
  $logPreview = Cli-Json @('logs','clear')
  Assert-True ($logPreview.data.dry_run -eq $true -and $logPreview.data.deleted_files -eq 0) 'Installed log preview deleted files.'
  $logsCleared = Cli-Json @('logs','clear','--older-than-days','0','--yes')
  Assert-True ($logsCleared.data.dry_run -eq $false -and $logsCleared.data.deleted_files -eq 0) 'Installed empty log cleanup failed.'
  Write-Host 'Checking that an active service blocks upgrade.'
  Assert-True ((Run-Installer) -ne 0) 'Upgrade did not block a running application.'
  [void](Cli-Json @('service','stop'))
  Write-Host 'Checking upgrade after normal shutdown.'
  Assert-True ((Run-Installer) -eq 0) 'Stopped application could not be upgraded.'
  Assert-True ((Get-FileHash (Join-Path $config 'config.json')).Hash -eq $configHash) 'Upgrade changed user configuration.'
  Assert-True (Test-Path -LiteralPath (Join-Path $install 'keep-user-file.txt')) 'Upgrade removed an unknown user file.'
  $environment = $registry.OpenSubKey($keyName + '\Environment')
  Assert-True ($environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -eq $installedPath) 'Upgrade duplicated PATH entries.'
  $environment.Dispose()

  $uninstaller = Join-Path $install 'Uninstall.exe'
  Write-Host 'Checking uninstall and data preservation.'
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(40)
  while (((Test-Path -LiteralPath (Join-Path $install 'install-manifest.json')) -or (Test-Path -LiteralPath $uninstaller)) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  Assert-True (!(Test-Path -LiteralPath (Join-Path $install 'bin\saplink.exe'))) 'Uninstall left the launcher installed.'
  Assert-True (!(Test-Path -LiteralPath (Join-Path $install 'app'))) 'Uninstall left application dependencies, dotfiles or empty directories.'
  Assert-True (!(Test-Path -LiteralPath (Join-Path $install 'runtime'))) 'Uninstall left the bundled runtime directory.'
  Assert-True (Test-Path -LiteralPath (Join-Path $install 'keep-user-file.txt')) 'Uninstall removed an unknown file.'
  Assert-True ((Get-FileHash (Join-Path $config 'config.json')).Hash -eq $configHash) 'Uninstall changed user configuration.'
  $environment = $registry.OpenSubKey($keyName + '\Environment')
  Assert-True ($environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -eq $originalTestPath) 'Uninstall did not restore the test PATH.'
  $environment.Dispose()
  $actualEnvironment = $registry.OpenSubKey('Environment')
  Assert-True ($actualEnvironment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -eq $actualPath) 'Real user PATH was modified by isolated tests.'
  $actualEnvironment.Dispose()
  Write-Host "Installer smoke checks passed ($Architecture): offline install, shortcuts, PATH, arbitrary working directory, native CLI, background lifecycle, upgrade guard, configuration preservation, uninstall."
} finally {
  if (Test-Path -LiteralPath (Join-Path $install 'bin\saplink.exe')) {
    & (Join-Path $install 'bin\saplink.exe') service stop --json | Out-Null
  }
  $env:Path = $oldPath
  $env:SAPLINK_CONFIG_DIR = $oldConfig
  $env:SAPLINK_LOG_DIR = $oldLogs
  # Isolated files intentionally remain in TEMP for failure inspection.
  if (!(Test-Path -LiteralPath (Join-Path $install 'install-manifest.json'))) { $registry.DeleteSubKeyTree($keyName, $false) }
}
