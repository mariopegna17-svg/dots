#!/usr/bin/env bash
set -euo pipefail
dots_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export COMPUTER_PROVIDER="${COMPUTER_PROVIDER:-docker}"
export DATA_DIR="${DATA_DIR:-$dots_root/server/.data}"
export NEXT_TELEMETRY_DISABLED=1
cd "$dots_root/server"
setsid .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
dots_api_pid=$!
cd "$dots_root/client"
setsid node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3000 &
dots_web_pid=$!
trap 'kill -- -"$dots_api_pid" -"$dots_web_pid" 2>/dev/null || true; wait || true' EXIT INT TERM
wait -n "$dots_api_pid" "$dots_web_pid"
