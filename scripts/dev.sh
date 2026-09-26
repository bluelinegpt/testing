#!/usr/bin/env bash
# Starts the BlueLineGPT dev servers (API on :3000, Public on :5174, Portal on :5177) in one terminal.
# All run together; press Ctrl+C once to stop them.
# Usage (Git Bash / macOS / Linux, from anywhere):  bash scripts/dev.sh

set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is not installed or not on PATH. Install it with: npm install -g pnpm" >&2
  exit 1
fi

echo "Starting BlueLineGPT dev servers from $root"
echo "  API -> http://localhost:3000"
echo "  Public -> http://localhost:5174"
echo "  Portal -> http://localhost:5177"

pnpm --filter @blueline/api dev &
api_pid=$!
pnpm --filter @blueline/public-web dev &
public_pid=$!
pnpm --filter @blueline/web dev &
web_pid=$!

# Stop both servers when this script is interrupted or exits.
trap 'kill "$api_pid" "$public_pid" "$web_pid" 2>/dev/null || true' EXIT INT TERM

echo ""
echo "Servers starting. Home page: http://localhost:5174  Company Portal: http://localhost:5177 (Ctrl+C to stop all)."
wait
