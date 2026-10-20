param(
  [string]$Version,
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (!$Version) { $Version = (Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Use a stable three-part version.' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repository "outputs\installers\$Version" }
$OutputDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$source = Join-Path $repository 'skills\saplink-manager'
if (!(Test-Path -LiteralPath (Join-Path $source 'SKILL.md') -PathType Leaf)) { throw 'saplink-manager/SKILL.md is missing.' }
# Reject junctions and symlinks before recursing into a source directory.
$pending = New-Object 'Collections.Generic.Queue[string]'
$pending.Enqueue($source)
$files = New-Object 'Collections.Generic.List[string]'
[long]$total = 0
while ($pending.Count -gt 0) {
  $directory = $pending.Dequeue()
  if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Skill source must not contain links.' }
  foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Skill source must not contain links.' }
    if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName); continue }
    if ($entry.Length -gt 1MB) { throw 'A skill source file exceeds 1 MiB.' }
    $total += $entry.Length
    $files.Add($entry.FullName)
    if ($files.Count -gt 128 -or $total -gt 8MB) { throw 'Skill source exceeds packaging limits.' }
  }
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$name = "SapLink-$Version-skill.zip"
$target = Join-Path $OutputDirectory $name
$temporary = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
$ordered = $files.ToArray()
[Array]::Sort($ordered, [StringComparer]::Ordinal)
try {
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew)
  try {
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($file in $ordered) {
        $relative = $file.Substring($source.Length + 1).Replace('\', '/')
        $item = $zip.CreateEntry(('saplink-manager/' + $relative), [IO.Compression.CompressionLevel]::NoCompression)
        $item.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $inputStream = [IO.File]::OpenRead($file)
        $entryStream = $item.Open()
        try {
          # Match Git's canonical text even when Windows checkout uses core.autocrlf.
          if ([IO.Path]::GetExtension($file).ToLowerInvariant() -in @('.md','.yaml','.yml')) {
            $text = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($file)).Replace("`r`n", "`n")
            $bytes = [Text.Encoding]::UTF8.GetBytes($text)
            $entryStream.Write($bytes, 0, $bytes.Length)
          } else { $inputStream.CopyTo($entryStream) }
        } finally { $entryStream.Dispose(); $inputStream.Dispose() }
      }
    } finally { $zip.Dispose() }
  } finally { $stream.Dispose() }
  if ((Get-Item -LiteralPath $temporary).Length -gt 16MB) { throw 'Skill ZIP exceeds 16 MiB.' }
  Move-Item -LiteralPath $temporary -Destination $target -Force
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(($target + '.sha256'), "$hash  $name`n", [Text.Encoding]::ASCII)
  Write-Host "Created: $target"
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
