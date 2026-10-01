@echo off
rem Apply the installed spooler.env and prove the existing agent reconnects.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0spooler-service.ps1" -Action refresh
if errorlevel 1 pause
