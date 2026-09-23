# Packs the add-on from addon/ into an .xpi in dist/ (file name includes the version from manifest.json).
# Usage: pwsh ./build.ps1

$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "addon"
$dist = Join-Path $PSScriptRoot "dist"
$version = (Get-Content (Join-Path $source "manifest.json") -Raw | ConvertFrom-Json).version
$target = Join-Path $dist "calmirror-$version.xpi"

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $target) {
  Remove-Item $target
}

# Paths inside the archive must use "/", hence not Compress-Archive
$zip = [System.IO.Compression.ZipFile]::Open($target, "Create")
try {
  foreach ($file in Get-ChildItem $source -Recurse -File) {
    $entry = [System.IO.Path]::GetRelativePath($source, $file.FullName).Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry, "Optimal") | Out-Null
  }
} finally {
  $zip.Dispose()
}

Write-Host "Created: $target"
