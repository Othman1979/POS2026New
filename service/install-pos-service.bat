@echo off
REM ============================================================
REM  Install the POS app (server.js) as a Windows Service.
REM  Auto-starts on boot, auto-restarts on crash.
REM  RIGHT-CLICK -> "Run as administrator".
REM ============================================================
setlocal enableextensions

REM --- Service name. Change only if you run more than one POS on this box. ---
set "SVC_NAME=PosApp"

REM --- OPTIONAL: if MySQL runs as a Windows service, put its name here
REM     (XAMPP service name is usually "mysql") so POS waits for the DB on boot.
set "MYSQL_SERVICE="

REM --- Must be Administrator ---
net session >nul 2>&1
if errorlevel 1 goto :no_admin

REM --- Resolve folders (works no matter where the project lives) ---
set "SVC_DIR=%~dp0"
pushd "%~dp0.."
set "PROJECT_DIR=%CD%"
popd

REM --- Find node.exe ---
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto :no_node

if not exist "%PROJECT_DIR%\server.js" goto :no_server

REM --- Get nssm.exe (one-time download if missing) ---
set "NSSM=%SVC_DIR%nssm.exe"
if not exist "%NSSM%" call :get_nssm
if not exist "%NSSM%" goto :no_nssm

if not exist "%SVC_DIR%logs" mkdir "%SVC_DIR%logs"

echo.
echo Installing service "%SVC_NAME%"
echo   node     : %NODE_EXE%
echo   project  : %PROJECT_DIR%
echo.

"%NSSM%" install %SVC_NAME% "%NODE_EXE%" "server.js"
"%NSSM%" set %SVC_NAME% AppDirectory "%PROJECT_DIR%"
"%NSSM%" set %SVC_NAME% DisplayName "POS App (posapp)"
"%NSSM%" set %SVC_NAME% Description "Restaurant POS Node server (server.js)"
"%NSSM%" set %SVC_NAME% Start SERVICE_AUTO_START
"%NSSM%" set %SVC_NAME% AppStdout "%SVC_DIR%logs\pos-out.log"
"%NSSM%" set %SVC_NAME% AppStderr "%SVC_DIR%logs\pos-err.log"
"%NSSM%" set %SVC_NAME% AppRotateFiles 1
"%NSSM%" set %SVC_NAME% AppRotateOnline 1
"%NSSM%" set %SVC_NAME% AppRotateBytes 10485760
"%NSSM%" set %SVC_NAME% AppStopMethodConsole 15000
"%NSSM%" set %SVC_NAME% AppExit Default Restart
"%NSSM%" set %SVC_NAME% AppRestartDelay 3000
"%NSSM%" set %SVC_NAME% AppEnvironmentExtra NODE_ENV=production
if defined MYSQL_SERVICE "%NSSM%" set %SVC_NAME% DependOnService "%MYSQL_SERVICE%"

echo.
echo Starting service...
"%NSSM%" start %SVC_NAME%
echo.
sc query %SVC_NAME%
echo.
echo Done. POS auto-starts on every boot.
echo   App   : http://localhost:3000  (and http://THIS-PC-IP:3000 on the LAN)
echo   Logs  : %SVC_DIR%logs
echo   Control: start-pos.bat / stop-pos.bat / restart-pos.bat / status-pos.bat
goto :end

:get_nssm
echo Downloading NSSM (one-time, needs internet)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile \"$env:TEMP\nssm.zip\"; Expand-Archive -Force \"$env:TEMP\nssm.zip\" \"$env:TEMP\nssm_x\"; Copy-Item \"$env:TEMP\nssm_x\nssm-2.24\win64\nssm.exe\" '%NSSM%' -Force } catch { Write-Host $_; exit 1 }"
exit /b

:no_admin
echo [ERROR] Not running as Administrator. Right-click this file -^> "Run as administrator".
goto :end
:no_node
echo [ERROR] Node.js not found in PATH. Install Node.js (or add it to PATH) and retry.
goto :end
:no_server
echo [ERROR] server.js not found in: %PROJECT_DIR%
echo         Keep this script inside  posapp\service\  so it can find the project.
goto :end
:no_nssm
echo [ERROR] Could not get nssm.exe automatically.
echo         Download NSSM from https://nssm.cc , and copy the win64\nssm.exe into:
echo         %SVC_DIR%
echo         then run this script again.
goto :end
:end
echo.
pause
endlocal
