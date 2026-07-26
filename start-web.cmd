@echo off
rem BlueLineGPT Web dev server (http://localhost:5174). Press Ctrl+C to stop.
cd /d "%~dp0"
where pnpm >nul 2>nul || (echo pnpm is not installed or not on PATH. Run: npm install -g pnpm & pause & exit /b 1)
echo Starting BlueLineGPT Web on http://localhost:5174 ...
call pnpm --filter @blueline/web dev
pause
