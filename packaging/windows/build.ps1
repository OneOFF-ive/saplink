param(
  [ValidateSet('x64','arm64')][string[]]$Architecture = @('x64','arm64'),
  [switch]$SkipTests,
  [switch]$TestMode,
  [string]$RfcBuildJavaHome = $env:JAVA_HOME,
  [string]$RfcBuildJcoJar,
  [string]$RfcJavaDirectory,
  [string]$RfcJcoDirectory
)
$ErrorActionPreference = 'Stop'
$vcRuntimeDlls = @('vcruntime140.dll','vcruntime140_1.dll','vcruntime140_threads.dll','msvcp140.dll')
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$localRuntime = Join-Path $repository 'local-runtime\windows-x64'
if (!$RfcJavaDirectory) { $RfcJavaDirectory = Join-Path $localRuntime 'java' }
if (!$RfcJcoDirectory) { $RfcJcoDirectory = Join-Path $localRuntime 'jco' }
$buildRoot = Join-Path $repository '.saplink\installer-build'
$cache = Join-Path $repository '.saplink\installer-cache'
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'download-lock.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Installer requires a three-part numeric application version.' }
$output = Join-Path $repository ("outputs\installers\" + $package.version)
if ($TestMode) { $output = Join-Path $buildRoot 'tests' }
New-Item -ItemType Directory -Force -Path $buildRoot,$cache,$output | Out-Null
$npmCli = Join-Path (Split-Path -Parent (Get-Command npm.cmd).Source) 'node_modules\npm\bin\npm-cli.js'

function Assert-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" } }
function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Download-Verified([string[]]$Urls, [string]$Path, [string]$Sha256) {
  if ((Test-Path -LiteralPath $Path) -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Sha256) { return }
  foreach ($url in $Urls) {
    try {
      Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile ($Path + '.download') -TimeoutSec 180
      if ((Get-FileHash -LiteralPath ($Path + '.download') -Algorithm SHA256).Hash -ne $Sha256) { throw 'Downloaded file hash mismatch' }
      Move-Item -LiteralPath ($Path + '.download') -Destination $Path -Force
      return
    } catch { Write-Host "Download source unavailable or did not match the pinned hash: $url" }
  }
  throw "No verified download available for $([IO.Path]::GetFileName($Path))"
}
function Reset-Stage([string]$Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  if (!$absolute.StartsWith([IO.Path]::GetFullPath($buildRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Build cleanup target is outside the build directory.' }
  if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
  New-Item -ItemType Directory -Path $absolute | Out-Null
}

function Get-RfcJavaInfo {
  foreach ($relative in @('bin\java.exe','bin\server\jvm.dll','release','legal\java.base\LICENSE')) {
    if (!(Test-Path -LiteralPath (Join-Path $RfcJavaDirectory $relative) -PathType Leaf)) {
      throw "Local RFC Java is incomplete: $RfcJavaDirectory ($relative). Populate local-runtime\windows-x64\java before building; Java is not downloaded automatically."
    }
  }
  $properties = @{}
  foreach ($line in (Get-Content -LiteralPath (Join-Path $RfcJavaDirectory 'release'))) {
    if ($line -match '^([A-Z_]+)="([^"]*)"$') { $properties[$matches[1]] = $matches[2] }
  }
  if ($properties.OS_NAME -ne 'Windows' -or $properties.OS_ARCH -notin @('x86_64','amd64') -or !$properties.JAVA_VERSION) {
    throw 'Local RFC Java must be a Windows x64 runtime with its original release metadata.'
  }
  $version = if ($properties.JAVA_RUNTIME_VERSION) { $properties.JAVA_RUNTIME_VERSION } else { $properties.JAVA_VERSION }
  return @{
    distribution = $properties.IMPLEMENTOR
    version = $version
    architecture = 'x64'
    source = 'local-runtime'
    java_exe_sha256 = (Get-FileSha256 (Join-Path $RfcJavaDirectory 'bin\java.exe'))
    jvm_sha256 = (Get-FileSha256 (Join-Path $RfcJavaDirectory 'bin\server\jvm.dll'))
    release_sha256 = (Get-FileSha256 (Join-Path $RfcJavaDirectory 'release'))
  }
}

function Copy-RfcJava([string]$Arch, [string]$Runtime) {
  # Both packages use the same local x64 Java/JCo under Windows 11 ARM64 emulation.
  $java = Join-Path $Runtime 'java'
  Copy-Item -LiteralPath $RfcJavaDirectory -Destination $java -Recurse
  & (Join-Path $java 'bin\java.exe') -version
  Assert-Exit 'Bundled RFC Java startup'
  # Copy the complete local runtime, including legal notices and release metadata.
}

function Install-ProductionDependencies([string]$App, [string]$Arch) {
  # npm misresolves file: dependencies on UNC shares. Install on a local disk,
  # then copy the real package files (--install-links avoids external symlinks).
  $temporaryRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP 'SapLink-dependencies-build'))
  $temporary = Join-Path $temporaryRoot ([Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $App 'package.json'),(Join-Path $App 'package-lock.json') -Destination $temporary
  Copy-Item -LiteralPath (Join-Path $App 'vendor') -Destination $temporary -Recurse
  & node $npmCli --prefix $temporary ci --omit=dev --ignore-scripts --install-links --os=win32 "--cpu=$Arch" --no-audit --no-fund
  Assert-Exit "Production dependencies ($Arch)"
  Copy-Item -LiteralPath (Join-Path $temporary 'node_modules') -Destination $App -Recurse
  if (![IO.Path]::GetFullPath($temporary).StartsWith($temporaryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe dependency cleanup path.' }
  Remove-Item -LiteralPath $temporary -Recurse -Force
}

function Copy-VcRuntime([string]$Arch, [string]$Stage, [string]$NativeDirectory) {
  $bundle = Join-Path $cache "vc_redist.$Arch.exe"
  Download-Verified @($lock.vcRuntime.$Arch.url) $bundle $lock.vcRuntime.$Arch.sha256
  $signature = Get-AuthenticodeSignature -LiteralPath $bundle
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation,') {
    throw 'Microsoft runtime signature verification failed.'
  }
  # expand.exe cannot reliably process CABs on UNC shares. Use a fresh local
  # temporary directory; retain it on failure for inspection.
  $extractRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP 'SapLink-runtime-build'))
  $extract = Join-Path $extractRoot ([Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $extract -Force | Out-Null
  & node (Join-Path $PSScriptRoot 'extract-cabinets.cjs') $bundle $extract
  Assert-Exit 'Runtime container extraction'
  foreach ($name in @('license','payload','dlls')) { New-Item -ItemType Directory -Path (Join-Path $extract $name) | Out-Null }
  & expand.exe (Join-Path $extract 'container-0.cab') '-F:*' (Join-Path $extract 'license') | Out-Null
  Assert-Exit 'Runtime license extraction'
  & expand.exe (Join-Path $extract 'container-1.cab') '-F:*' (Join-Path $extract 'payload') | Out-Null
  Assert-Exit 'Runtime payload extraction'
  foreach ($payload in (Get-ChildItem -LiteralPath (Join-Path $extract 'payload') -File)) {
    # Burn payloads contain MSI metadata and CABs; only CAB data is decompressed.
    $stream = [IO.File]::OpenRead($payload.FullName)
    try { $magic = New-Object byte[] 4; [void]$stream.Read($magic, 0, 4) } finally { $stream.Dispose() }
    if ([Text.Encoding]::ASCII.GetString($magic) -ne 'MSCF') { continue }
    & expand.exe $payload.FullName '-F:*' (Join-Path $extract 'dlls') | Out-Null
    Assert-Exit 'Runtime DLL extraction'
  }
  foreach ($name in $vcRuntimeDlls) {
    $suffix = if ($Arch -eq 'x64') { 'amd64' } else { 'arm64' }
    $file = Join-Path $extract "dlls\$($name)_$suffix"
    $dllSignature = Get-AuthenticodeSignature -LiteralPath $file
    if ($dllSignature.Status -ne 'Valid' -or $dllSignature.SignerCertificate.Subject -notmatch '^CN=Microsoft (Corporation|Windows Software Compatibility Publisher), O=Microsoft Corporation,') { throw "Invalid runtime DLL signature: $name" }
    # libuv uses LOAD_WITH_ALTERED_SEARCH_PATH: addon dependencies must sit
    # beside the .node file, rather than beside the node.exe executable.
    Copy-Item -LiteralPath $file -Destination (Join-Path $NativeDirectory $name)
  }
  Copy-Item -LiteralPath (Join-Path $extract 'license\u4') -Destination (Join-Path $Stage 'licenses\Microsoft-VC-Runtime.rtf')
  if (![IO.Path]::GetFullPath($extract).StartsWith($extractRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe extraction cleanup path.' }
  Remove-Item -LiteralPath $extract -Recurse -Force
}

function Get-RfcJcoArchive([string]$Directory) {
  if (!(Test-Path -LiteralPath $Directory -PathType Container)) {
    throw "Local RFC JCo is missing: $Directory. Populate local-runtime\windows-x64\jco before building."
  }
  $archivePattern = '^(sapjco3|com\.sap\.conn\.jco[-_]\d+\.\d+\.\d+)\.jar$'
  $candidates = @(Get-ChildItem -LiteralPath $Directory -File | Where-Object { $_.Name -match $archivePattern })
  if ($candidates.Count -ne 1) {
    throw 'JCo directory must contain exactly one original JCo JAR. Preserve its original filename.'
  }
  return $candidates[0]
}

function Assert-X64JcoLibrary([string]$Path) {
  $dosMagic = 0x5a4d
  $peMagic = 0x4550
  $amd64Machine = 0x8664
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes, 0) -ne $dosMagic) {
    throw 'JCo DLL is not a Windows PE file.'
  }

  # The DOS header stores the PE header offset at byte 60.
  $peHeaderOffset = [BitConverter]::ToInt32($bytes, 60)
  if ($peHeaderOffset -lt 0 -or $peHeaderOffset -gt $bytes.Length - 6) {
    throw 'RFC runtime requires an x64 JCo DLL, including in the ARM64 installer.'
  }
  $signature = [BitConverter]::ToUInt32($bytes, $peHeaderOffset)
  $machine = [BitConverter]::ToUInt16($bytes, $peHeaderOffset + 4)
  if ($signature -ne $peMagic -or $machine -ne $amd64Machine) {
    throw 'RFC runtime requires an x64 JCo DLL, including in the ARM64 installer.'
  }
}

function Copy-RfcJco([string]$Runtime) {
  $missingRuntimeMessage = 'A complete internal installer requires -RfcJcoDirectory containing an original JCo JAR and x64 sapjco3.dll.'
  if (!$RfcJcoDirectory) { throw $missingRuntimeMessage }

  $jarPath = Join-Path $RfcJcoDirectory $rfcJarFile
  $libraryPath = Join-Path $RfcJcoDirectory 'sapjco3.dll'
  if (!(Test-Path -LiteralPath $jarPath) -or !(Test-Path -LiteralPath $libraryPath)) {
    throw $missingRuntimeMessage
  }
  Assert-X64JcoLibrary $libraryPath
  $destination = Join-Path $Runtime 'jco'
  New-Item -ItemType Directory -Path $destination | Out-Null
  # Preserve the supplied SDK documentation and license files without repacking the JAR.
  Copy-Item -Path (Join-Path $RfcJcoDirectory '*') -Destination $destination -Recurse
  $manifest = @{
    schema_version = 1
    architecture = 'x64'
    distribution = 'internal'
    jar_file = $rfcJarFile
    jar_sha256 = (Get-FileSha256 (Join-Path $destination $rfcJarFile))
    native_sha256 = (Get-FileSha256 (Join-Path $destination 'sapjco3.dll'))
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Runtime 'rfc-runtime.json') -Encoding ASCII
  return $manifest
}

function Assert-BundledRfcRuntime([string]$App, [string]$Runtime, [string]$Arch, [string]$JarFile) {
  $java = Join-Path $Runtime 'java\bin\java.exe'
  $nativeDirectory = Join-Path $Runtime 'jco'
  $classes = Join-Path $App 'bridge\classes'
  $jar = Join-Path $nativeDirectory $JarFile
  $javaArguments = @("-Djava.library.path=$nativeDirectory", '-cp', "$classes;$jar", 'SapLinkRfcBridge', '--check-runtime')
  $savedJavaOptions = @($env:JAVA_TOOL_OPTIONS, $env:JDK_JAVA_OPTIONS, $env:_JAVA_OPTIONS)
  try {
    $env:JAVA_TOOL_OPTIONS = ''
    $env:JDK_JAVA_OPTIONS = ''
    $env:_JAVA_OPTIONS = ''
    & $java @javaArguments
    Assert-Exit "Bundled Java/JCo load check ($Arch, x64 JVM)"
  } finally {
    $env:JAVA_TOOL_OPTIONS = $savedJavaOptions[0]
    $env:JDK_JAVA_OPTIONS = $savedJavaOptions[1]
    $env:_JAVA_OPTIONS = $savedJavaOptions[2]
  }
}

Push-Location $repository
try {
  $javaReceipt = Get-RfcJavaInfo
  $jcoArchive = Get-RfcJcoArchive $RfcJcoDirectory
  $rfcJarFile = $jcoArchive.Name
  if (!$RfcBuildJcoJar) { $RfcBuildJcoJar = $jcoArchive.FullName }
  if (!$SkipTests) {
    & node $npmCli --prefix $repository test; Assert-Exit 'Tests'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'payload-test.ps1')
    Assert-Exit 'Installer payload cleanup tests'
  }
  else { & node $npmCli --prefix $repository run build; Assert-Exit 'Build' }
  $bridgeClass = Join-Path $repository 'bridge\classes\SapLinkRfcBridge.class'
  if ($RfcBuildJavaHome -and $RfcBuildJcoJar) {
    & (Join-Path $repository 'bridge\build.ps1') -JavaHome $RfcBuildJavaHome -JcoJar $RfcBuildJcoJar
    Assert-Exit 'RFC bridge compilation'
  } elseif (!(Test-Path -LiteralPath $bridgeClass) -or (Get-Item -LiteralPath $bridgeClass).LastWriteTimeUtc -lt (Get-Item -LiteralPath (Join-Path $repository 'bridge\src\SapLinkRfcBridge.java')).LastWriteTimeUtc) {
    throw 'Compile the RFC bridge first, or supply -RfcBuildJavaHome and -RfcBuildJcoJar. The internal runtime SDK must be supplied separately from the source tree.'
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $nsisZip = Join-Path $cache 'nsis-3.12.zip'
  Download-Verified $lock.nsis.urls $nsisZip $lock.nsis.sha256
  $compiler = Join-Path $cache 'nsis-3.12\makensis.exe'
  if (!(Test-Path -LiteralPath $compiler)) { [IO.Compression.ZipFile]::ExtractToDirectory($nsisZip, $cache) }
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
  if (!(Test-Path -LiteralPath $csc)) { throw 'The Windows .NET Framework C# compiler is required for launchers.' }

  foreach ($arch in $Architecture) {
    $stage = Join-Path $buildRoot ("stage-" + $arch)
    Reset-Stage $stage
    $app = Join-Path $stage 'app'
    $runtime = Join-Path $stage 'runtime'
    $bin = Join-Path $stage 'bin'
    New-Item -ItemType Directory -Path $app,$runtime,$bin | Out-Null
    $nodeFile = "node-v$($lock.nodeVersion)-win-$arch.zip"
    $nodeZip = Join-Path $cache $nodeFile
    Download-Verified @("https://nodejs.org/dist/v$($lock.nodeVersion)/$nodeFile") $nodeZip $lock.node.$arch.sha256
    $archive = [IO.Compression.ZipFile]::OpenRead($nodeZip)
    try {
      foreach ($name in @('node.exe','LICENSE')) {
        $entry = $archive.GetEntry("node-v$($lock.nodeVersion)-win-$arch/$name")
        if (!$entry) { throw "Node archive is missing $name" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $name), $true)
      }
    } finally { $archive.Dispose() }
    Copy-RfcJava $arch $runtime
    $jcoReceipt = Copy-RfcJco $runtime
    Copy-Item -LiteralPath (Join-Path $repository 'package.json'),(Join-Path $repository 'package-lock.json') -Destination $app
    Copy-Item -LiteralPath (Join-Path $repository 'vendor') -Destination $app -Recurse
    Install-ProductionDependencies $app $arch
    foreach ($directory in @('dist','web','docs','skills','bridge')) {
      Copy-Item -LiteralPath (Join-Path $repository $directory) -Destination $app -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $repository 'README.md') -Destination $app
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'installer-control.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-runner.ps1') -Destination $stage
    New-Item -ItemType Directory -Path (Join-Path $stage 'licenses') | Out-Null
    Copy-Item -LiteralPath (Join-Path $cache 'nsis-3.12\COPYING') -Destination (Join-Path $stage 'licenses\NSIS-COPYING.txt')
    $nativeDirectory = Join-Path $app "node_modules\@napi-rs\keyring-win32-$arch-msvc"
    Copy-VcRuntime $arch $stage $nativeDirectory
    $rfcVcDirectory = $nativeDirectory
    if ($arch -eq 'arm64') {
      $rfcVcDirectory = Join-Path $buildRoot 'rfc-vc-x64'
      Reset-Stage $rfcVcDirectory
      Copy-VcRuntime 'x64' $stage $rfcVcDirectory
    }
    if (Test-Path -LiteralPath (Join-Path $runtime 'java\bin')) {
      foreach ($dll in $vcRuntimeDlls) {
        Copy-Item -LiteralPath (Join-Path $rfcVcDirectory $dll) -Destination (Join-Path $runtime 'java\bin') -Force
        Copy-Item -LiteralPath (Join-Path $rfcVcDirectory $dll) -Destination (Join-Path $runtime 'jco') -Force
      }
    }
    & (Join-Path $PSScriptRoot 'generate-icon.ps1') -Output (Join-Path $stage 'saplink.ico') -WebIcon (Join-Path $app 'web\app-icon.png')
    $iconHash = (Get-FileHash -LiteralPath (Join-Path $stage 'saplink.ico')).Hash.Substring(0,12).ToLowerInvariant()
    $iconName = "saplink-$iconHash.ico"
    & $csc /nologo /target:exe /platform:anycpu /codepage:65001 "/win32icon:$stage\saplink.ico" "/out:$bin\saplink.exe" (Join-Path $PSScriptRoot 'Launcher.cs')
    Assert-Exit 'Console launcher compilation'
    & $csc /nologo /target:winexe /platform:anycpu /codepage:65001 /define:GUI /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32manifest:$PSScriptRoot\GuiLauncher.manifest" "/win32icon:$stage\saplink.ico" "/out:$bin\saplink-gui.exe" (Join-Path $PSScriptRoot 'Launcher.cs') (Join-Path $PSScriptRoot 'GuiLauncher.cs')
    Assert-Exit 'GUI launcher compilation'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'GuiLauncher.config') -Destination (Join-Path $bin 'saplink-gui.exe.config')
    # Loading the actual prebuilt addon catches accidental host/target architecture mixing.
    & (Join-Path $runtime 'node.exe') (Join-Path $PSScriptRoot 'native-smoke.cjs') (Join-Path $app 'node_modules\@napi-rs\keyring') $nativeDirectory
    Assert-Exit "Native module smoke check ($arch)"
    & (Join-Path $bin 'saplink.exe') --version; Assert-Exit "Launcher smoke check ($arch)"

    Assert-BundledRfcRuntime -App $app -Runtime $runtime -Arch $arch -JarFile $rfcJarFile

    $receipt = @{
      app_version = $package.version
      node_version = $lock.nodeVersion
      architecture = $arch
      built_at = [DateTime]::UtcNow.ToString('o')
      node_archive_sha256 = $lock.node.$arch.sha256
      nsis_archive_sha256 = $lock.nsis.sha256
      vc_runtime_version = $lock.vcRuntime.version
      vc_runtime_archive_sha256 = $lock.vcRuntime.$arch.sha256
    }
    $receipt.distribution = 'internal'
    $receipt.rfc_java = $javaReceipt
    $receipt.rfc_jco = $jcoReceipt
    $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'build-info.json') -Encoding UTF8
    # NSIS packages dotfiles and empty directories too; record the same complete payload.
    $files = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($stage.Length + 1) })
    $directories = @(Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force | ForEach-Object { $_.FullName.Substring($stage.Length + 1) })
    $installManifest = @{
      schema_version = 1
      app_id = 'org.saplink.desktop'
      version = $package.version
      architecture = $arch
      files = $files
      directories = $directories
    }
    $installManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'install-manifest.json') -Encoding UTF8
    $suffix = if ($TestMode) { '-test' } else { '' }
    $target = Join-Path $output "SapLink-$($package.version)-win-$arch$suffix-setup.exe"
    $arguments = @('/V2', '/INPUTCHARSET', 'UTF8', "/DAPP_VERSION=$($package.version)", "/DTARGET_ARCH=$arch", "/DSTAGE_DIR=$stage", "/DOUTPUT_FILE=$target", "/DICON_FILENAME=$iconName")
    if ($TestMode) { $arguments += '/DTEST_MODE' }
    & $compiler @arguments (Join-Path $PSScriptRoot 'installer.nsi'); Assert-Exit "Installer compilation ($arch)"
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($target))" | Set-Content -LiteralPath ($target + '.sha256') -Encoding ASCII
    Write-Host "Created: $target"
  }
  & (Join-Path $PSScriptRoot 'package-skill.ps1') -Version $package.version -OutputDirectory $output
} finally { Pop-Location }
