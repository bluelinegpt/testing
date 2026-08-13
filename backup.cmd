@echo off
setlocal EnableDelayedExpansion

:: ============================================================================
:: BluelineGPT backup script
::
:: Copies the important/source files of C:\Dev\BlueLineGPT into a timestamped
:: zip archive at C:\dev\backupBlueline<yyyyMMdd>.zip.
::
:: Generated/dependency/tooling folders are excluded (they regenerate on
:: their own and would otherwise make the archive gigabytes in size):
::   node_modules, .git, .tools, .pnpm-store, .codex-pnpm, backup, .backups,
::   .sync-freeorder, .test-failures, outputs, mobile_app\build,
::   mobile_app\.dart_tool, apps\*\dist
::
:: Usage:
::   backup.cmd
:: ============================================================================

set "SOURCE=C:\Dev\BlueLineGPT"
set "OUT_DIR=C:\dev"
set "STAGE=%TEMP%\blueline_backup_stage"

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

:: Today's date as YYYYMMDD, computed via PowerShell so it does not depend on
:: the machine's regional date format (unlike the batch %DATE% variable).
for /f %%D in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd')"') do set "TODAY=%%D"

set "ZIP=%OUT_DIR%\backupBlueline%TODAY%.zip"

echo.
echo Backing up:  %SOURCE%
echo To:          %ZIP%
echo.

:: Start from a clean staging folder.
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"

:: Mirror the source into the staging folder, skipping generated/tooling
:: directories. /XJ skips junctions/symlinks (avoids copy loops). Bare names
:: (no path) match at ANY depth -- required for node_modules/dist, which a
:: pnpm workspace nests inside every app AND inside node_modules itself.
robocopy "%SOURCE%" "%STAGE%" /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS ^
  /XD "node_modules" ^
  /XD "dist" ^
  /XD "%SOURCE%\.git" ^
  /XD "%SOURCE%\.tools" ^
  /XD "%SOURCE%\.pnpm-store" ^
  /XD "%SOURCE%\.codex-pnpm" ^
  /XD "%SOURCE%\backup" ^
  /XD "%SOURCE%\.backups" ^
  /XD "%SOURCE%\.sync-freeorder" ^
  /XD "%SOURCE%\.test-failures" ^
  /XD "%SOURCE%\outputs" ^
  /XD "%SOURCE%\mobile_app\build" ^
  /XD "%SOURCE%\mobile_app\.dart_tool" ^
  /XD "%SOURCE%\apps\api\dist" ^
  /XD "%SOURCE%\apps\web\dist" ^
  /XD "%SOURCE%\apps\platform-web\dist" ^
  /XF "*.log"

:: Robocopy exit codes 0-7 mean success (files copied/skipped as expected);
:: 8 or higher means a real error occurred.
if %ERRORLEVEL% GEQ 8 (
  echo.
  echo Robocopy reported an error ^(exit code !ERRORLEVEL!^) - aborting, nothing was zipped.
  rmdir /s /q "%STAGE%" >nul 2>&1
  exit /b 1
)

:: Zip the staged copy.
if exist "%ZIP%" del /f /q "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%ZIP%' -CompressionLevel Optimal"

:: Clean up the staging folder either way.
rmdir /s /q "%STAGE%" >nul 2>&1

if exist "%ZIP%" (
  echo.
  echo Backup complete: %ZIP%
) else (
  echo.
  echo Backup FAILED - the zip file was not created.
  exit /b 1
)

endlocal
