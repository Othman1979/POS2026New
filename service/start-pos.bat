@echo off
REM Start the POS service. Run as administrator.
setlocal
set "SVC_NAME=PosApp"
net session >nul 2>&1
if errorlevel 1 (echo [ERROR] Run as administrator. & pause & exit /b 1)
net start %SVC_NAME%
echo.
sc query %SVC_NAME% | findstr /i "STATE"
pause
endlocal
