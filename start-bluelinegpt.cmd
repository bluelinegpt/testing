@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ===========================================================================
rem BlueLineGPT development environment.
rem
rem One command to start everything. Safe to run repeatedly: it stops the
rem previous BlueLineGPT servers first, waits for their ports to be released,
rem and only then starts fresh ones.
rem
rem   API ......... http://localhost:3000   @blueline/api
rem   Web ......... http://localhost:5174   @blueline/web
rem   Store ....... http://localhost:5175   @blueline/store
rem   Platform .... http://localhost:5176   @blueline/platform-web
rem
rem Every Vite server here is configured with `strictPort: true`, so a port
rem left behind by a previous run is a hard failure rather than a silent move
rem to the next free port. That is why the stop phase exists at all: closing a
rem server window with the X button kills the console host but leaves node.exe
rem running and holding the port. Ctrl+C stops it properly; this script makes
rem either habit work.
rem
rem WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
rem   - It never runs `taskkill /IM node.exe`. Codex, Claude, other projects and
rem     unrelated Node tools are commonly running on the same machine, and a
rem     blanket kill would take them with it. Only a process that is BOTH
rem     listening on one of the four ports above AND is node.exe is stopped.
rem   - It runs no migration, seed, reset, bootstrap or accounting import. It
rem     starts servers and nothing else. Those are administrative operations
rem     with their own commands, and doing them on every start would make an
rem     everyday action carry consequences nobody asked for.
rem ===========================================================================

cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem Self-dispatch. Each server window re-invokes this same file with --serve so
rem there is exactly one place that knows how a BlueLineGPT service is started.
rem A second copy of the pnpm command in a helper script is a second place to
rem forget to update.
rem
rem The standalone `start-api.cmd` and `start-web.cmd` are unchanged and still
rem work on their own; this path runs the identical pnpm command from the same
rem directory.
rem ---------------------------------------------------------------------------
if /i "%~1"=="--serve" goto :serve

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm is not installed or not on PATH. Run: npm install -g pnpm
  pause
  exit /b 1
)

echo ========================================
echo  BlueLineGPT Development Environment
echo ========================================
echo.
echo Stopping existing BlueLineGPT services...
echo.

call :closewindows

call :stopapi
call :stopsvc "API      " 3000 "BlueLineGPT API (port 3000)"
call :stopsvc "Web      " 5174 "BlueLineGPT Web (port 5174)"
call :stopsvc "Store    " 5175 "BlueLineGPT Store (port 5175)"
call :stopsvc "Platform " 5176 "BlueLineGPT Platform (port 5176)"

echo.
echo Waiting for ports to be released...
echo.

set "BLOCKED="
call :waitfree "API      " 3000
call :waitfree "Web      " 5174
call :waitfree "Store    " 5175
call :waitfree "Platform " 5176

if defined BLOCKED (
  echo.
  echo Not starting: the ports listed above are still held by something this
  echo script will not terminate. Free them and run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting BlueLineGPT...
echo.

call :startsvc "API      " "BlueLineGPT API (port 3000)"      @blueline/api
call :startsvc "Web      " "BlueLineGPT Web (port 5174)"      @blueline/web
call :startsvc "Store    " "BlueLineGPT Store (port 5175)"    @blueline/store
call :startsvc "Platform " "BlueLineGPT Platform (port 5176)" @blueline/platform-web

echo.
echo Waiting for each service to listen...
echo.

rem A window opening is not a server starting. Each port is polled until it is
rem actually accepting connections, so "started" means started.
set "FAILED="
call :waitup "API      " 3000
call :waitup "Web      " 5174
call :waitup "Store    " 5175
call :waitup "Platform " 5176

echo.
echo ----------------------------------------
if defined FAILED (
  echo BlueLineGPT started with FAILURES
  echo.
  echo These services did not begin listening:%FAILED%
  echo Check their windows for the error.
) else (
  echo BlueLineGPT started
)
echo.
echo Company Portal:
echo   http://localhost:5174
echo.
echo Storefront:
echo   http://localhost:5175
echo.
echo Platform Admin:
echo   http://localhost:5176
echo.
echo API:
echo   http://localhost:3000
echo ----------------------------------------
echo.
echo Stop a service with Ctrl+C in its window, or just run this script again.

if defined FAILED exit /b 1
exit /b 0


rem ===========================================================================
rem :serve <package>  -- runs inside one of the spawned windows.
rem ===========================================================================
:serve
shift
echo Starting %~1 ...
echo.
call pnpm --filter %~1 dev
echo.
echo %~1 has exited.
pause
exit /b 0


rem ===========================================================================
rem :stopapi
rem
rem The API runs under `tsx watch`, which is a SUPERVISOR that does not itself
rem bind port 3000 -- it spawns a CHILD node process that does, and relaunches
rem a fresh one automatically whenever the child dies or a source file changes.
rem
rem `:stopsvc` below only ever stops whichever process is listening on a port.
rem For the three Vite dev servers that IS the whole process, so it is a
rem complete stop. For the API it is not: killing only the child leaves the
rem supervisor running, and the supervisor immediately spawns a replacement --
rem so the port frees for an instant and then a SECOND api process reappears
rem on it, racing whatever this script starts next. Across one long session
rem this produced four API processes at once, all silently answering requests
rem with whichever was fastest, which made "restart the API and check the log"
rem an unreliable diagnostic for hours.
rem
rem The fix is to stop the supervisor too, found by command line rather than
rem by port: any node.exe process whose command line names both this
rem repository and `main.ts` is either the supervisor or one of its children,
rem regardless of which one currently holds the port.
rem
rem Matched client-side, not with WMI -Filter -- a -Filter string needs escaped
rem double quotes that cmd's ^-continuation swallows, which silently returns
rem zero rows rather than erroring (the same trap :closewindows above hit).
rem ===========================================================================
:stopapi
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$repo = '%~dp0';" ^
  "$repo = $repo.TrimEnd('\\');" ^
  "$found = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |" ^
  "  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($repo) -and $_.CommandLine.Contains('main.ts') });" ^
  "foreach($p in $found){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }" ^
  "if($found.Count -gt 0){ Write-Host ('API       .......... stopped ' + $found.Count + ' tsx watch process(es), supervisor included') }"
rem A moment for the supervisor's own child-death handler to run and settle,
rem so it does not race the fresh start below.
ping -n 2 127.0.0.1 >nul
exit /b 0


rem ===========================================================================
rem :stopsvc <label> <port> <window-title>
rem
rem Stops the previous instance of one service, scoped two ways:
rem
rem   1. By port AND image name. A PID is only terminated if it is listening on
rem      this service's port and its process is node.exe. Anything else on the
rem      port belongs to somebody else and is reported, not killed.
rem   2. By this script's own window title, as a follow-up, to close the console
rem      host left behind. /T so the tree goes with it; the title is specific
rem      enough that nothing else matches, and failure is ignored.
rem
rem Nothing to stop is a normal outcome, not an error.
rem ===========================================================================
:stopsvc
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port=%2;" ^
  "$ids=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique);" ^
  "if($ids.Count -eq 0){ Write-Host '%~1 .......... not running' ; exit 0 }" ^
  "$stopped=$false; $foreign=$null;" ^
  "foreach($id in $ids){" ^
  "  $p = Get-Process -Id $id -ErrorAction SilentlyContinue;" ^
  "  if(-not $p){ continue }" ^
  "  if($p.ProcessName -eq 'node'){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $stopped=$true }" ^
  "  else { $foreign = $p.ProcessName + ' (PID ' + $id + ')' }" ^
  "}" ^
  "if($stopped){ Write-Host '%~1 .......... stopped' }" ^
  "if($foreign){ Write-Host ('%~1 .......... NOT MINE - port ' + $port + ' held by ' + $foreign + ', left alone') }" ^
  "if(-not $stopped -and -not $foreign){ Write-Host '%~1 .......... not running' }"

exit /b 0


rem ===========================================================================
rem :closewindows
rem
rem Closes the server windows a previous run of THIS script opened, and with
rem them the pnpm/node children underneath.
rem
rem Scoped by command line, not by window title. A window title is not reliably
rem queryable (a console spawned from a detached parent reports none), and
rem `taskkill /FI "WINDOWTITLE eq ..."` silently matches nothing in that case.
rem The match is done client-side rather than with -Filter: a WMI filter needs
rem escaped double quotes, and cmd's ^-continuation swallows them, so the query
rem silently returned nothing at all. Every string here is single-quoted.
rem
rem A command line containing this script's own full path cannot belong to
rem anything but this script -- not to Codex, not to Claude, not to another
rem project, not even to a second checkout of this repository elsewhere on
rem disk. It is the narrowest identifier available.
rem
rem This is a convenience: it stops dead windows accumulating across runs. The
rem port-scoped stop below is the one that actually guarantees a free port, and
rem it also covers servers started some other way (start-api.cmd, a bare pnpm
rem command, a previous shell).
rem ===========================================================================
:closewindows
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me = '%~f0';" ^
  "$found = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |" ^
  "  Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.Contains($me) -and $_.CommandLine.Contains('--serve') });" ^
  "foreach($w in $found){" ^
  "  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |" ^
  "    Where-Object { $_.ParentProcessId -eq $w.ProcessId } |" ^
  "    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "  Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue" ^
  "}" ^
  "if($found.Count -gt 0){ Write-Host ('Closed ' + $found.Count + ' window(s) from a previous run.') }"
exit /b 0


rem ===========================================================================
rem :waitfree <label> <port>
rem
rem A socket does not close the instant its process dies. Starting the new
rem server before the old one has released the port is the race this avoids --
rem with strictPort it would surface as EADDRINUSE and the service would simply
rem not come up.
rem ===========================================================================
:waitfree
set "_attempt=0"
:waitfree_loop
set /a _attempt+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if(Get-NetTCPConnection -LocalPort %2 -State Listen -ErrorAction SilentlyContinue){ exit 1 } else { exit 0 }"
if not errorlevel 1 (
  echo %~1 .......... port %2 free
  exit /b 0
)
if %_attempt% GEQ 15 (
  echo %~1 .......... port %2 STILL IN USE
  set "BLOCKED=1"
  exit /b 0
)
rem `ping` rather than `timeout`: `timeout` aborts with "Input redirection is
rem not supported" whenever this script runs non-interactively.
ping -n 2 127.0.0.1 >nul
goto :waitfree_loop


rem ===========================================================================
rem :startsvc <label> <window-title> <package>
rem ===========================================================================
:startsvc
start "%~2" cmd /k ""%~f0" --serve %3"
echo %~1 .......... starting
exit /b 0


rem ===========================================================================
rem :waitup <label> <port>
rem
rem Polls until the port is listening. The first run after a dependency change
rem can take a while to compile, so this is patient (up to ~90s) rather than
rem declaring a slow start a failure.
rem ===========================================================================
:waitup
set "_attempt=0"
:waitup_loop
set /a _attempt+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if(Get-NetTCPConnection -LocalPort %2 -State Listen -ErrorAction SilentlyContinue){ exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo %~1 .......... listening on %2
  exit /b 0
)
if %_attempt% GEQ 45 (
  echo %~1 .......... FAILED to listen on %2
  set "FAILED=!FAILED! %~1"
  exit /b 0
)
ping -n 3 127.0.0.1 >nul
goto :waitup_loop
