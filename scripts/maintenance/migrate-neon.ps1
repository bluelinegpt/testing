# Runs the database migrations against Neon (production) from this folder.
# The connection string is typed at the prompt, used once, and cleared.
# It is never written to a file and never printed back.
# Usage (from C:\Dev\BlueLineGPT):
#   powershell -ExecutionPolicy Bypass -File scripts\maintenance\migrate-neon.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

Write-Host ""
Write-Host "Neon console > Bluelinegpt > Connect > branch 'main', database 'neondb', pooling OFF > Copy" -ForegroundColor Cyan
$connection = Read-Host "Paste the Neon connection string here and press Enter"
$connection = $connection.Trim().Trim('"').Trim("'")

try {
  if ($connection -notmatch '^postgres(ql)?://[^@]+@([^/:?]+)') {
    Write-Host "That is not a postgresql:// connection string. Nothing was run." -ForegroundColor Red
    exit 1
  }
  $server = $Matches[2]
  if ($server -notmatch '\.neon\.tech$') {
    Write-Host "Server '$server' is not a Neon server. Nothing was run." -ForegroundColor Red
    exit 1
  }
  if ($server -match '-pooler') {
    Write-Host "This is the pooled connection. Copy it again with pooling OFF. Nothing was run." -ForegroundColor Red
    exit 1
  }

  Write-Host ""
  Write-Host "Server: $server"
  $answer = Read-Host "Type YES to run the migrations on this Neon server"
  if ($answer.Trim().ToUpper() -ne "YES") {
    Write-Host "Cancelled. Nothing was run." -ForegroundColor Yellow
    exit 1
  }

  $env:DATABASE_URL = $connection
  pnpm --filter @blueline/api db:migrate
}
finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  $connection = $null
  Write-Host "Connection string cleared from this window." -ForegroundColor DarkGray
}
