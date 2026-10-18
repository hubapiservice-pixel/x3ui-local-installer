Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$zip = Join-Path $root "dist\X3-UI-Offline-Installer-Windows-x64-v1.4.0.zip"
$stage = Join-Path $env:RUNNER_TEMP ("x3ui-windows-e2e-" + [guid]::NewGuid().ToString("N"))
$bundle = Join-Path $stage "X3-UI Offline Installer Windows x64"
$serverPid = $null

try {
  Expand-Archive -Path $zip -DestinationPath $stage
  $node = Join-Path $bundle "runtime\node.exe"
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
  $serverPid = [int]$pidLine.Substring("X3UI_PID=".Length)
  $env:X3UI_TEST_INSTALLER_URL = $urlLine.Substring("X3UI_URL=".Length)
  & $node (Join-Path $root "scripts\e2e-container.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Windows container install or node probe failed." }
} finally {
  Remove-Item Env:X3UI_TEST_INSTALLER_URL -ErrorAction SilentlyContinue
  if ($serverPid) { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
}
