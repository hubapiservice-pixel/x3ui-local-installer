@echo off
setlocal
set "X3UI_ROOT=%~dp0"
"%X3UI_ROOT%runtime\node.exe" "%X3UI_ROOT%launcher.mjs"
if errorlevel 1 (
  echo X3-UI Offline Installer could not start. See the error above.
  if not "%X3UI_NO_BROWSER%"=="1" pause
  exit /b 1
)
