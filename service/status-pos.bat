@echo off
REM Show POS service status + last log lines. (No admin needed.)
setlocal
set "SVC_NAME=PosApp"
set "SVC_DIR=%~dp0"
echo ===== SERVICE STATE =====
sc query %SVC_NAME%
echo.
echo ===== LAST 20 LOG LINES (stdout) =====
powershell -NoProfile -Command "if (Test-Path '%SVC_DIR%logs\pos-out.log') { Get-Content '%SVC_DIR%logs\pos-out.log' -Tail 20 } else { 'no log yet' }"
echo.
echo ===== LAST 20 LOG LINES (errors) =====
powershell -NoProfile -Command "if (Test-Path '%SVC_DIR%logs\pos-err.log') { Get-Content '%SVC_DIR%logs\pos-err.log' -Tail 20 } else { 'no error log' }"
echo.
pause
endlocal
