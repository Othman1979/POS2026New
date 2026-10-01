@echo off
rem Retire the local identity after a server/station change and prove the new agent connects.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0spooler-service.ps1" -Action rebind
if errorlevel 1 pause
