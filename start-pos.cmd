@echo off
cd /d "%~dp0"
if not exist .env (
  echo This PC is not set up yet. Run: powershell -ExecutionPolicy Bypass -File scripts\setup-localhost.ps1
  pause
  exit /b 1
)
set PORT=3000
for /f "tokens=1,* delims==" %%a in ('findstr /b "PORT=" .env') do set PORT=%%b
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:%PORT%"
node server.js
pause
