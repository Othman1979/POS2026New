@echo off
REM Stop the POS service (graceful). Run as administrator.
setlocal
set "SVC_NAME=PosApp"
net session >nul 2>&1
if errorlevel 1 (echo [ERROR] Run as administrator. & pause & exit /b 1)
net stop %SVC_NAME%
echo.
sc query %SVC_NAME% | findstr /i "STATE"
pause
endlocal
