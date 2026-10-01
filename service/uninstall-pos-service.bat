@echo off
REM Remove the POS Windows service. Run as administrator.
setlocal
set "SVC_NAME=PosApp"
set "SVC_DIR=%~dp0"
set "NSSM=%SVC_DIR%nssm.exe"
net session >nul 2>&1
if errorlevel 1 (echo [ERROR] Run as administrator. & pause & exit /b 1)
echo Stopping %SVC_NAME% ...
net stop %SVC_NAME% 2>nul
if exist "%NSSM%" (
  "%NSSM%" remove %SVC_NAME% confirm
) else (
  sc delete %SVC_NAME%
)
echo.
echo Service removed. Files and database are untouched.
pause
endlocal
