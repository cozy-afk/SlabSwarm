#!/usr/bin/env bash
set -euo pipefail

cd /app
DATA_DIR="${SLABGRAPH_DATA_DIR:-/app/data}"

echo "[slabswarm] boot gate: verifying runtime"
command -v node >/dev/null 2>&1 || { echo "[slabswarm] FATAL: node missing"; exit 1; }
[ -x node_modules/.bin/tsx ] || { echo "[slabswarm] FATAL: tsx missing"; exit 1; }
[ -f dist/index.html ] || { echo "[slabswarm] FATAL: frontend build missing"; exit 1; }

mkdir -p "$DATA_DIR"
if ! touch "$DATA_DIR/.write-probe" 2>/dev/null; then
  echo "[slabswarm] FATAL: data dir not writable: $DATA_DIR"
  exit 1
fi
rm -f "$DATA_DIR/.write-probe"

echo "[slabswarm] state dir: $DATA_DIR"
ls -la "$DATA_DIR"

if [ -f /app/.env ]; then
  echo "[slabswarm] /app/.env present"
else
  echo "[slabswarm] WARNING: no /app/.env file; relying on injected environment only"
fi

if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "MY_GEMINI_API_KEY" ]; then
  echo "[slabswarm] Gemini key: configured"
else
  echo "[slabswarm] Gemini key: MISSING (LLM features stay disabled until keys are entered)"
fi

echo "[slabswarm] starting server on port ${PORT:-3000}"
exec ./node_modules/.bin/tsx server.ts
