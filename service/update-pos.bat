@echo off
REM ============================================================
REM  Update workflow: stop -> copy new files -> rebuild frontend ->
REM  automatic additive migrations -> start. Admin required.
REM ============================================================
setlocal enableextensions
set "SVC_NAME=PosApp"

net session >nul 2>&1
if errorlevel 1 goto :no_admin

set "SVC_DIR=%~dp0"
pushd "%~dp0.."
set "PROJECT_DIR=%CD%"
popd

echo ============================================================
echo  POS UPDATE
echo ============================================================
echo Stopping service...
net stop %SVC_NAME% 2>nul

echo.
echo Service is stopped. Now do your update:
echo   1) Copy the updated project files into:
echo        %PROJECT_DIR%
echo   2) If package.json changed, open a terminal there and run:  npm install
echo.
echo When finished, press any key to rebuild and restart.
echo Approved additive database migrations will run before the server starts.
pause >nul

cd /d "%PROJECT_DIR%"
echo.
echo Rebuilding frontend (npm run build)...
call npm run build
if errorlevel 1 goto :build_failed

echo.
echo Applying approved additive database migrations...
node deployment\tools\run-pending-migrations.js --env "%PROJECT_DIR%\.env"
if errorlevel 1 goto :migration_failed

echo.
echo Starting service...
net start %SVC_NAME%
if errorlevel 1 goto :start_failed
echo.
sc query %SVC_NAME% | findstr /i "STATE"
echo Update complete.
goto :end

:start_failed
echo.
echo [ERROR] Service did not start. Automatic migration or schema validation may have refused the database.
echo Review service\logs\pos-err.log. If needed, use deployment\database\hostinger-manual-migrations.sql.
goto :end

:migration_failed
echo.
echo [ERROR] Database migration or additive repair FAILED. Service remains STOPPED.
echo Review the error above. If needed, import deployment\database\hostinger-manual-migrations.sql.
goto :end

:build_failed
echo.
echo [ERROR] Build FAILED. Service left STOPPED so a broken UI is not served.
echo Fix the error shown above, then run  start-pos.bat  (or re-run this) when ready.
goto :end
:no_admin
echo [ERROR] Run as administrator.
:end
echo.
pause
endlocal
