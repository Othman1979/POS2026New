@echo off
rem Restart after editing spooler.env and require a new authenticated heartbeat.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Refresh-Agent.ps1"
if errorlevel 1 pause
