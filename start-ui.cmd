@echo off
setlocal
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and try again.
  pause
  popd
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci --ignore-scripts
  if errorlevel 1 goto failed
)
call npm.cmd run build
if errorlevel 1 goto failed
node scripts/dev-cli.mjs ui
if errorlevel 1 goto failed
popd
exit /b 0
:failed
echo Startup failed. Review the error above.
pause
popd
exit /b 1
