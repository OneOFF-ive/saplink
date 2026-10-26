param(
  [string]$ReleaseTag = '',
  [string]$Directory = '',
  [switch]$DryRun,
  [string]$Python = ''
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pythonArgs = @()
if ($Python) {
  $pythonCommand = (Get-Command $Python -ErrorAction Stop).Source
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $pythonCommand = (Get-Command py).Source
  $pythonArgs = @('-3')
} else {
  $command = Get-Command python -ErrorAction SilentlyContinue
  if (!$command -or $command.Source -like '*\Microsoft\WindowsApps\*') {
    throw 'Install Python 3.10+ or provide -Python C:\path\to\python.exe.'
  }
  $pythonCommand = $command.Source
}
& $pythonCommand @pythonArgs -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }

if (!$DryRun) {
  $environment = Join-Path $repository '.saplink\cos-local\venv'
  $venvPython = Join-Path $environment 'Scripts\python.exe'
  if (!(Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    & $pythonCommand @pythonArgs -m venv $environment
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated COS Python environment.' }
  }
  $sdkCheck = @"
import sys
try:
 import importlib.metadata as m
 from qcloud_cos import CosConfig
 assert m.version('cos-python-sdk-v5') == '1.9.44'
except Exception:
 sys.exit(1)
"@
  & $venvPython -c $sdkCheck
  if ($LASTEXITCODE -ne 0) {
    & $venvPython -m pip install --disable-pip-version-check cos-python-sdk-v5==1.9.44
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned COS SDK. Check the local pip network connection.' }
  }
  $pythonCommand = $venvPython
  $pythonArgs = @()
}

$arguments = @((Join-Path $PSScriptRoot 'sync-cos-local.py'))
if ($ReleaseTag) { $arguments += @('--tag', $ReleaseTag) }
if ($Directory) { $arguments += @('--directory', $Directory) }
if ($DryRun) { $arguments += '--dry-run' }
& $pythonCommand @pythonArgs @arguments
if ($LASTEXITCODE -ne 0) { throw "Local COS synchronization failed with exit code $LASTEXITCODE." }
