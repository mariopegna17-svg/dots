#!/usr/bin/env bash
set -euo pipefail
dots_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$dots_root/.cache/uv}"
export npm_config_cache="${npm_config_cache:-$dots_root/.cache/npm}"
export NEXT_TELEMETRY_DISABLED=1
cd "$dots_root"
if [ ! -x server/.venv/bin/python ]; then
  uv venv server/.venv
fi
uv pip install --python server/.venv/bin/python --require-hashes -r server/requirements.lock
cd "$dots_root/client"
npm ci --no-audit --no-fund
npm run build
cd "$dots_root/whatsapp"
npm ci --no-audit --no-fund
cd "$dots_root"
python3 scripts/build_computer.py
