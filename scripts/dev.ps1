# Starts the BlueLineGPT dev servers (API on :3000, Web on :5174).
# Each server opens in its own PowerShell window so you can read its logs and stop it with Ctrl+C.
# Usage (from anywhere):  pwsh -File scripts\dev.ps1   (or right-click > Run with PowerShell)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Error "pnpm is not installed or not on PATH. Install it with:  npm install -g pnpm"
  exit 1
}

Write-Host "Starting BlueLineGPT dev servers from $root" -ForegroundColor Cyan
Write-Host "  API -> http://localhost:3000" -ForegroundColor DarkGray
Write-Host "  Web -> http://localhost:5174" -ForegroundColor DarkGray

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; Write-Host 'BlueLineGPT API (port 3000)' -ForegroundColor Green; pnpm --filter @blueline/api dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; Write-Host 'BlueLineGPT Web (port 5174)' -ForegroundColor Green; pnpm --filter @blueline/web dev"

Write-Host "`nTwo windows opened. When both are ready, open http://localhost:5174" -ForegroundColor Cyan
Write-Host "Close a window (or press Ctrl+C in it) to stop that server." -ForegroundColor DarkGray
