@echo off
rem Use only after draining or force-replacing the old station identity in Admin.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Refresh-Agent.ps1" -ResetIdentity
if errorlevel 1 pause
