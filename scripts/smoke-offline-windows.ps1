Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$zip = Join-Path $root "dist\X3-UI-Offline-Installer-Windows-x64-v1.3.0.zip"
$checksum = "$zip.sha256"
$expected = (Get-Content $checksum -Raw).Split(" ")[0]
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Windows package checksum mismatch." }

$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$stage = Join-Path $temporaryRoot ("x3ui-windows-smoke-" + [guid]::NewGuid().ToString("N"))
$bundle = Join-Path $stage "X3-UI Offline Installer Windows x64"
$serverPid = $null
try {
  Expand-Archive -Path $zip -DestinationPath $stage
  $node = Join-Path $bundle "runtime\node.exe"
  $xray = Join-Path $bundle "app\offline-assets\tools\xray-windows-x64.exe"
  if ((& $node --version) -ne "v24.15.0") { throw "Bundled Node.js did not run." }
  if ((& $xray version | Select-Object -First 1) -notmatch "Xray 26\.3\.27") { throw "Bundled Xray did not run." }
  if ((Get-ChildItem -File (Join-Path $bundle "app\offline-assets\clients")).Count -ne 14) {
    throw "The package is missing offline clients."
  }

  $env:X3UI_NO_BROWSER = "1"
  Push-Location $bundle
  try {
    $launchOutput = & cmd.exe /d /c Start-X3UI.cmd
    if ($LASTEXITCODE -ne 0) { throw "Windows launcher failed." }
  } finally {
    Pop-Location
    Remove-Item Env:X3UI_NO_BROWSER -ErrorAction SilentlyContinue
  }
  $urlLine = $launchOutput | Where-Object { $_ -match "^X3UI_URL=" } | Select-Object -Last 1
  $pidLine = $launchOutput | Where-Object { $_ -match "^X3UI_PID=" } | Select-Object -Last 1
  if (-not $urlLine -or -not $pidLine) { throw "Launcher did not report its URL and process ID." }
  $url = $urlLine.Substring("X3UI_URL=".Length)
  $serverPid = [int]$pidLine.Substring("X3UI_PID=".Length)
  if ($url -notmatch "^http://127\.0\.0\.1:4\d{3}/$") { throw "Launcher used an unexpected bind address." }

  $edition = Invoke-RestMethod -Uri "${url}api/edition"
  if ($edition.edition -ne "offline" -or $edition.platform -ne "windows-x64" -or $edition.instance -ne $bundle) {
    throw "The extracted Windows package did not start in offline mode."
  }
  $client = [System.Net.Http.HttpClient]::new()
  try {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "${url}api/edition")
    $request.Headers.Host = "external.example"
    $blocked = $client.Send($request)
    if ([int]$blocked.StatusCode -ne 403) { throw "Non-loopback Host was not blocked." }
    $probe = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "${url}api/probe")
    $probe.Content = [System.Net.Http.StringContent]::new('{"link":"bad"}', [Text.Encoding]::UTF8, "application/json")
    if ([int]$client.Send($probe).StatusCode -ne 400) { throw "Probe endpoint did not validate the link." }
  } finally {
    $client.Dispose()
  }
  $download = Invoke-WebRequest -Method Head -Uri "${url}downloads/v2rayN-windows-64.zip" -UseBasicParsing
  if ([int]$download.StatusCode -ne 200) { throw "Bundled Windows client is not served locally." }
  Write-Output "Windows x64 ZIP, launcher, embedded runtimes, loopback server, and client download passed."
} finally {
  if ($serverPid) { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
}
