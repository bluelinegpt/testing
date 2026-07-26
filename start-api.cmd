@echo off
rem BlueLineGPT API dev server (http://localhost:3000). Press Ctrl+C to stop.
cd /d "%~dp0"
where pnpm >nul 2>nul || (echo pnpm is not installed or not on PATH. Run: npm install -g pnpm & pause & exit /b 1)
echo Starting BlueLineGPT API on http://localhost:3000 ...
call pnpm --filter @blueline/api dev
pause
