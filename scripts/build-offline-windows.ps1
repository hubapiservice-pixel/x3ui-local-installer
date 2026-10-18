Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$version = "1.4.0"
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "X3-UI-Offline-Installer-Windows-x64-v$version.zip"
$checksum = "$zip.sha256"
$stage = Join-Path $dist ".windows-build-v$version"
$bundle = Join-Path $stage "X3-UI Offline Installer Windows x64"
$app = Join-Path $bundle "app"
$tools = Join-Path $root "offline-assets\build-tools"

function Assert-Hash([string]$file, [string]$expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA-256 mismatch: $file" }
}

function Get-PinnedFile([string]$url, [string]$file, [string]$expected) {
  if (Test-Path $file) {
    Assert-Hash $file $expected
    return
  }
  $partial = "$file.part"
  if (Test-Path $partial) { Remove-Item -Force $partial }
  try {
    Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing
    Assert-Hash $partial $expected
    Move-Item $partial $file
  } finally {
    if (Test-Path $partial) { Remove-Item -Force $partial }
  }
}

if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) {
  throw "Build this package on Windows x64."
}
if ((Test-Path $zip) -or (Test-Path $stage)) { throw "Output or staging path already exists." }
New-Item -ItemType Directory -Force -Path $dist, $tools | Out-Null

& node (Join-Path $root "scripts\fetch-offline-assets.mjs")
if ($LASTEXITCODE -ne 0) { throw "Offline assets failed verification or download." }
$bootstrap = Join-Path $root "release\offline-v3.9.0-xray-26.3.27\bootstrap.sh"
if ((Get-Content -Path $bootstrap -Raw).Contains("`r")) {
  throw "Linux bootstrap.sh has CRLF line endings; refusing to package it for Windows."
}

$nodeArchive = Join-Path $tools "node-v24.15.0-win-x64.zip"
$xrayArchive = Join-Path $tools "Xray-windows-64-v26.3.27.zip"
Get-PinnedFile "https://nodejs.org/download/release/v24.15.0/node-v24.15.0-win-x64.zip" $nodeArchive "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62"
Get-PinnedFile "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-windows-64.zip" $xrayArchive "d004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad"

try {
  New-Item -ItemType Directory -Force -Path $bundle, $app, (Join-Path $bundle "runtime"), (Join-Path $app "release"), (Join-Path $app "offline-assets") | Out-Null
  $extractedNode = Join-Path $stage "node-archive"
  $extractedXray = Join-Path $stage "xray-archive"
  Expand-Archive -Path $nodeArchive -DestinationPath $extractedNode
  Expand-Archive -Path $xrayArchive -DestinationPath $extractedXray
  Copy-Item (Join-Path $extractedNode "node-v24.15.0-win-x64\node.exe") (Join-Path $bundle "runtime\node.exe")
  Copy-Item (Join-Path $extractedNode "node-v24.15.0-win-x64\LICENSE") (Join-Path $bundle "runtime\LICENSE-node.txt")
  Copy-Item (Join-Path $root "packaging\windows-launcher.mjs") (Join-Path $bundle "launcher.mjs")
  Copy-Item (Join-Path $root "packaging\Start-X3UI.cmd") (Join-Path $bundle "Start-X3UI.cmd")
  Copy-Item (Join-Path $root "packaging\FIRST-OPEN-WINDOWS.txt") (Join-Path $bundle "FIRST-OPEN-WINDOWS.txt")

  foreach ($file in @("server.mjs", "container.mjs", "security.mjs", "remove.mjs", "probe.mjs", "package.json", "package-lock.json")) {
    Copy-Item (Join-Path $root $file) (Join-Path $app $file)
  }
  Copy-Item -Recurse (Join-Path $root "public") (Join-Path $app "public")
  Copy-Item -Recurse (Join-Path $root "release\offline-v3.9.0-xray-26.3.27") (Join-Path $app "release\offline-v3.9.0-xray-26.3.27")
  Copy-Item -Recurse (Join-Path $root "offline-assets\release") (Join-Path $app "offline-assets\release")
  Copy-Item -Recurse (Join-Path $root "offline-assets\clients") (Join-Path $app "offline-assets\clients")
  New-Item -ItemType Directory -Path (Join-Path $app "offline-assets\tools") | Out-Null
  $xrayExe = Join-Path $app "offline-assets\tools\xray-windows-x64.exe"
  Copy-Item (Join-Path $extractedXray "xray.exe") $xrayExe
  Copy-Item (Join-Path $extractedXray "LICENSE") (Join-Path $app "offline-assets\tools\LICENSE-xray.txt")
  Assert-Hash $xrayExe "15c2d007954ac53ba69b80ec91242786b3c0b71d52649165b4ca1d5cc96ef8f1"

  Push-Location $app
  try {
    & npm ci --omit=optional --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Windows npm ci failed." }
    & (Join-Path $bundle "runtime\node.exe") -e "require('ssh2'); require('express')"
    if ($LASTEXITCODE -ne 0) { throw "Bundled Windows dependencies failed to load." }
  } finally {
    Pop-Location
  }
  if (Get-ChildItem -Path (Join-Path $app "node_modules") -Recurse -Filter "*.node") {
    throw "Native optional modules were unexpectedly bundled."
  }

  Compress-Archive -Path $bundle -DestinationPath $zip -CompressionLevel Optimal
  $hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($checksum, "$hash  $(Split-Path $zip -Leaf)`n", [Text.Encoding]::ASCII)
  Write-Output "ZIP=$zip"
  Write-Output "SHA256=$hash"
} catch {
  if (Test-Path $zip) { Remove-Item -Force $zip }
  if (Test-Path $checksum) { Remove-Item -Force $checksum }
  throw
} finally {
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
}
