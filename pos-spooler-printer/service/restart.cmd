@echo off
rem Double-click me. The PowerShell script requests admin rights itself.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0spooler-service.ps1" -Action restart
if errorlevel 1 pause
