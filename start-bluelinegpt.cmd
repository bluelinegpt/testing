@echo off
rem Double-click to start both BlueLineGPT dev servers, each in its own window.
rem   API -> http://localhost:3000
rem   Web -> http://localhost:5174
cd /d "%~dp0"
start "BlueLineGPT API (port 3000)" cmd /k start-api.cmd
start "BlueLineGPT Web (port 5174)" cmd /k start-web.cmd
echo Two windows opened. When both are ready, open http://localhost:5174
