#!/usr/bin/env python3
"""Store eBay credentials in a private .env file without echoing them.

Run this yourself on the host over a TTY:

    python3 /opt/slabswarm/scripts/set-ebay-keys.py

SSH users should use: ssh -t <host> 'python3 /opt/slabswarm/scripts/set-ebay-keys.py'

Nothing is sent through chat, saved in this script, or printed to the screen.
Only the named variables are written. The file is replaced atomically with
mode 0600.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
MANAGED = {
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_REFRESH_TOKEN",
    "EBAY_TOKEN_TYPE",
    "EBAY_API_ENV",
}


def read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def update_lines(lines: list[str], values: dict[str, str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        match = re.match(r"^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=", stripped)
        if match and match.group(1) in MANAGED:
            key = match.group(1)
            if key in seen:
                continue
            seen.add(key)
            if key in values and values[key] != "":
                out.append(f"{key}={values[key]}")
            elif key == "EBAY_REFRESH_TOKEN":
                continue
            else:
                out.append(line)
        else:
            out.append(line)
    for key, value in values.items():
        if key not in seen and value != "":
            out.append(f"{key}={value}")
    return out


def write_private(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".env-ebay-", dir=str(path.parent))
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path("/opt/slabswarm/.env"),
        help="target env file (default: /opt/slabswarm/.env)",
    )
    args = parser.parse_args()
    if not sys.stdin.isatty():
        print("ERROR: run this in a real terminal (TTY required for hidden input).", file=sys.stderr)
        return 2

    print("eBay credentials will be written to", args.env_file)
    print("Values are hidden while you type and are never printed.\n")
    client_id = getpass.getpass("EBAY_CLIENT_ID: ").strip()
    client_secret = getpass.getpass("EBAY_CLIENT_SECRET: ").strip()
    refresh_token = getpass.getpass("EBAY_REFRESH_TOKEN (blank for application token): ").strip()
    environment = input("EBAY_API_ENV [sandbox/production] (default sandbox): ").strip().lower() or "sandbox"

    if environment not in {"sandbox", "production"}:
        print("ERROR: EBAY_API_ENV must be sandbox or production.", file=sys.stderr)
        return 2
    if not client_id or not client_secret:
        print("ERROR: client id and client secret are required.", file=sys.stderr)
        return 2
    for key, value in (
        ("EBAY_CLIENT_ID", client_id),
        ("EBAY_CLIENT_SECRET", client_secret),
        ("EBAY_REFRESH_TOKEN", refresh_token),
    ):
        if value and not KEY_RE.match(key):
            print(f"ERROR: invalid key name {key}", file=sys.stderr)
            return 2

    values = {
        "EBAY_CLIENT_ID": client_id,
        "EBAY_CLIENT_SECRET": client_secret,
        "EBAY_REFRESH_TOKEN": refresh_token,
        "EBAY_TOKEN_TYPE": "user" if refresh_token else "application",
        "EBAY_API_ENV": environment,
    }
    lines = update_lines(read_lines(args.env_file), values)
    write_private(args.env_file, lines)

    print("\nUpdated only these keys:")
    for key in ("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN", "EBAY_TOKEN_TYPE", "EBAY_API_ENV"):
        print(f"  {key}" + (" (cleared)" if key == "EBAY_REFRESH_TOKEN" and not refresh_token else ""))
    print(f"File mode: {oct(stat.S_IMODE(args.env_file.stat().st_mode))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
