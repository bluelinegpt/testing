#!/usr/bin/env bash
# Starts the BlueLineGPT dev servers (API on :3000, Web on :5174) in one terminal.
# Both run together; press Ctrl+C once to stop both.
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
echo "  Web -> http://localhost:5174"

pnpm --filter @blueline/api dev &
api_pid=$!
pnpm --filter @blueline/web dev &
web_pid=$!

# Stop both servers when this script is interrupted or exits.
trap 'kill "$api_pid" "$web_pid" 2>/dev/null || true' EXIT INT TERM

echo ""
echo "Both servers starting. When ready, open http://localhost:5174 (Ctrl+C to stop both)."
wait
