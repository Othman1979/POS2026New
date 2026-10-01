@echo off
REM ============================================================
REM  Run the POS in a console window WITHOUT installing a service.
REM  Good for testing / a quick manual run. Closing the window
REM  stops the app. (No admin needed.)
REM ============================================================
setlocal
pushd "%~dp0.."
set "PROJECT_DIR=%CD%"
popd
cd /d "%PROJECT_DIR%"
set "NODE_ENV=production"
echo Starting POS (node server.js) in %PROJECT_DIR%
echo Close this window or press Ctrl+C to stop.
echo.
node server.js
echo.
echo POS stopped.
pause
endlocal
