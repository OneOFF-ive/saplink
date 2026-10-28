param(
  [Parameter(Mandatory=$true)][string]$JavaHome,
  [Parameter(Mandatory=$true)][string]$JcoJar
)
$ErrorActionPreference = 'Stop'
$classes = Join-Path $PSScriptRoot 'classes'
$compiler = Join-Path $JavaHome 'bin/javac.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'JavaHome must contain bin/javac.exe.' }
if (!(Test-Path -LiteralPath $JcoJar -PathType Leaf)) { throw 'Supply a legally obtained JCo JAR.' }
New-Item -ItemType Directory -Force -Path $classes | Out-Null
& $compiler -encoding UTF-8 -source 8 -target 8 -cp ([IO.Path]::GetFullPath($JcoJar)) -d $classes (Join-Path $PSScriptRoot 'src/SapLinkRfcBridge.java')
if ($LASTEXITCODE -ne 0) { throw 'RFC bridge compilation failed.' }
Write-Output "RFC bridge compiled: $classes"
