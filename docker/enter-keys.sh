#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "Created $ENV_FILE from .env.example"
fi

echo
echo "SlabSwarm key entry"
echo "  1) Quick entry - Gemini key + admin settings"
echo "  2) Full editor  - all settings (nano/vim)"
read -rp "Choose [1]: " MODE
MODE="${MODE:-1}"

if [ "$MODE" = "2" ]; then
  EDITOR_BIN="${EDITOR:-}"
  if [ -z "$EDITOR_BIN" ]; then
    if command -v nano >/dev/null 2>&1; then
      EDITOR_BIN=nano
    elif command -v vim >/dev/null 2>&1; then
      EDITOR_BIN=vim
    else
      echo "No editor found. Install one: sudo apt install -y nano"
      exit 1
    fi
  fi
  "$EDITOR_BIN" "$ENV_FILE"
else
  read -rsp "GEMINI_API_KEY (hidden): " NEW_GEMINI_KEY; echo
  read -rsp "SLABGRAPH_ADMIN_PASSCODE (hidden, Enter to skip): " NEW_ADMIN_PASSCODE; echo
  read -rsp "SLABGRAPH_SESSION_SECRET (hidden, Enter to skip): " NEW_SESSION_SECRET; echo
  read -rp "GEMINI_MODEL [gemini-2.5-flash]: " NEW_GEMINI_MODEL
  NEW_GEMINI_MODEL="${NEW_GEMINI_MODEL:-gemini-2.5-flash}"

  SLAB_ENV_FILE="$ENV_FILE" \
  SLAB_GEMINI_KEY="$NEW_GEMINI_KEY" \
  SLAB_ADMIN_PASSCODE="$NEW_ADMIN_PASSCODE" \
  SLAB_SESSION_SECRET="$NEW_SESSION_SECRET" \
  SLAB_GEMINI_MODEL="$NEW_GEMINI_MODEL" \
  python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["SLAB_ENV_FILE"])
updates = {
    "GEMINI_API_KEY": os.environ["SLAB_GEMINI_KEY"],
    "GEMINI_MODEL": os.environ["SLAB_GEMINI_MODEL"],
}
if os.environ["SLAB_ADMIN_PASSCODE"]:
    updates["SLABGRAPH_ADMIN_PASSCODE"] = os.environ["SLAB_ADMIN_PASSCODE"]
if os.environ["SLAB_SESSION_SECRET"]:
    updates["SLABGRAPH_SESSION_SECRET"] = os.environ["SLAB_SESSION_SECRET"]

lines = path.read_text().splitlines(keepends=True)
seen = set()
out = []
for line in lines:
    stripped = line.strip()
    matched = None
    for key in updates:
        if stripped.startswith(key + "=") or stripped.startswith("# " + key + "="):
            matched = key
            break
    if matched:
        nl = "\n" if line.endswith("\n") else ""
        out.append(f"{matched}={updates[matched]}{nl}")
        seen.add(matched)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}\n")
path.write_text("".join(out))
PY
  echo "Wrote $ENV_FILE"
fi

echo
read -rp "Recreate container with these keys? [Y/n] " ANSWER
ANSWER="${ANSWER:-Y}"
if [[ "$ANSWER" =~ ^[Yy]$ ]]; then
  if sudo -n docker compose up -d --force-recreate >/dev/null 2>&1; then
    echo "Container recreated."
  else
    docker compose up -d --force-recreate
    echo "Container recreated."
  fi
  echo "Follow logs: sudo docker compose logs -f slabswarm"
  echo "Health check: curl -fsS http://10.99.0.1:3010/api/health"
else
  echo "Skipped restart. Start manually with: sudo docker compose up -d --force-recreate"
fi
