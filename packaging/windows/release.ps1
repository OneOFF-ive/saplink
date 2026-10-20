param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Version,
  [ValidateSet('x64','arm64')][string[]]$Architecture = @('x64','arm64'),
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'

# Keep the npm version and the Windows numeric file version compatible.
if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
  throw 'Use a three-part numeric version, for example 1.0.1 (no v prefix, leading zeros or prerelease suffix).'
}
foreach ($part in $Version.Split('.')) {
  $number = 0
  if (![int]::TryParse($part, [ref]$number) -or $number -gt 65535) {
    throw 'Each Windows version component must be between 0 and 65535.'
  }
}

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$packagePath = Join-Path $repository 'package.json'
$lockPath = Join-Path $repository 'package-lock.json'
$buildScript = Join-Path $PSScriptRoot 'build.ps1'
$npmCli = Join-Path (Split-Path -Parent (Get-Command npm.cmd -ErrorAction Stop).Source) 'node_modules\npm\bin\npm-cli.js'
[void](Get-Command node -ErrorAction Stop)
foreach ($path in @($packagePath, $lockPath, $buildScript, (Join-Path $PSScriptRoot 'package-skill.ps1'), $npmCli, (Join-Path $repository 'scripts\create-update-manifest.mjs'))) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file not found: $path" }
}

Push-Location $repository
try {
  # npm updates both manifests without committing, tagging or running version hooks.
  & node $npmCli --prefix $repository version $Version --no-git-tag-version --ignore-scripts --allow-same-version
  if ($LASTEXITCODE -ne 0) { throw "Version update failed with exit code $LASTEXITCODE." }
  # PowerShell 5.1 cannot parse the empty root key in npm's packages object.
  $versionsJson = & node -e "const fs = require('fs'); const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const l = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); console.log(JSON.stringify([p.version, l.version, l.packages[''].version]));" $packagePath $lockPath
  if ($LASTEXITCODE -ne 0) { throw 'Could not read version files; build was not started.' }
  $versions = $versionsJson | ConvertFrom-Json
  if ($versions.Count -ne 3 -or @($versions | Where-Object { $_ -ne $Version }).Count -gt 0) {
    throw 'package.json and package-lock.json versions are inconsistent; build was not started.'
  }

  Write-Host "Building SapLink $Version ($($Architecture -join ', '))."
  $buildOptions = @{ Architecture = $Architecture; SkipTests = $SkipTests }
  & $buildScript @buildOptions

  $output = Join-Path $repository "outputs\installers\$Version"
  & (Join-Path $PSScriptRoot 'package-skill.ps1') -Version $Version -OutputDirectory $output
  foreach ($arch in $Architecture) {
    $installer = Join-Path $output "SapLink-$Version-win-$arch-setup.exe"
    $expected = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($installer)
    if ((Get-Content -LiteralPath ($installer + '.sha256') -Raw).Trim() -ne $expected) {
      throw "Installer checksum mismatch: $arch"
    }
  }
  & node (Join-Path $repository 'scripts\create-update-manifest.mjs') --version $Version --directory $output --architectures ($Architecture -join ',')
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate the COS update manifest.' }
  Write-Host "Release build completed: $output"
  Write-Host 'Upload the versioned installers to COS first; publish latest.json as saplink/latest.json only after verifying their downloads.'
} catch {
  # Keep the requested version on failure so the same command can resume a rebuild.
  Write-Warning 'Release did not complete. Version files may already be updated; fix the error and rerun the same command.'
  throw
} finally {
  Pop-Location
}
