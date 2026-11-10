@echo off
setlocal
cd /d "%~dp0.."
set "SAPLINK_DEV_INSTALL_ROOT=%LOCALAPPDATA%\Programs\SapLink"
if not exist "%SAPLINK_DEV_INSTALL_ROOT%\runtime\node.exe" (
  echo Installed SapLink runtime was not found. Set up the development environment first.
  pause
  exit /b 1
)
"%SAPLINK_DEV_INSTALL_ROOT%\runtime\node.exe" scripts\start-agent-dev.mjs
if errorlevel 1 pause
endlocal
