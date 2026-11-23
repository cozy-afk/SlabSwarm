#!/usr/bin/env python3
"""Import eBay keys from a LOCAL text file without printing their values.

Copy the whole block from the eBay keys page — including the labels — and run:

    python3 /opt/slabswarm/scripts/import-ebay-keys.py --paste
    # paste the block, then press Ctrl-D

Or save the block to a local file and run:

    python3 /opt/slabswarm/scripts/import-ebay-keys.py --input ~/ebay-keys-paste.txt

The script detects labels such as "Client ID", "Client secret", "Cert ID" and
"Refresh token", whether the label is inline or on the line before the value.
If the paste contains both Sandbox and Production sections, only the section
matching --api-env is imported. It writes the matching values to
/opt/slabswarm/.env with mode 0600. It reports only field names and line
numbers; values are never printed. Unlabeled blobs and masked values are
rejected rather than guessed.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
import tempfile
import termios
from pathlib import Path

MANAGED = {
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_REFRESH_TOKEN",
    "EBAY_TOKEN_TYPE",
    "EBAY_API_ENV",
}

# Order matters: cert/client secret is checked before generic "client".
LABEL_PATTERNS = [
    ("EBAY_REFRESH_TOKEN", re.compile(r"refresh\s*token", re.I)),
    ("EBAY_CLIENT_SECRET", re.compile(r"cert\s*(id)?|client\s*secret|secret\s*(id)?", re.I)),
    ("EBAY_CLIENT_ID", re.compile(r"client\s*id|app\s*id|application\s*id", re.I)),
]
SECRET_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{12,}$")


def key_for_label(text: str) -> str | None:
    for key, pattern in LABEL_PATTERNS:
        if pattern.search(text):
            return key
    return None


def detect(text: str, api_env: str) -> tuple[dict[str, str], list[int], list[int]]:
    """Find labelled values in the chosen section. Labels may be inline or on the preceding line."""
    found: dict[str, str] = {}
    unlabeled: list[int] = []
    masked: list[int] = []
    pending: str | None = None
    section: str | None = None
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        if re.fullmatch(r"sandbox|production", line, re.I):
            section = line.lower()
            pending = None
            continue
        if section is not None and section != api_env:
            continue
        # Inline form: "Client ID: value" or "App ID (Client ID) value".
        match = re.match(r"^([^:=]{2,60})\s*[:=\t]\s*(.+)$", line)
        if match:
            key = key_for_label(match.group(1))
            value = match.group(2).strip()
            if key:
                if SECRET_RE.match(value):
                    found[key] = value
                elif "•" in value or "*" in value:
                    masked.append(number)
                pending = None
                continue
        # Label on its own line; the value follows on a later line. Never treat
        # a value that merely contains the word "cert" as another label.
        key = key_for_label(line) if not SECRET_RE.match(line) else None
        if key:
            pending = key
            continue
        if pending:
            if SECRET_RE.match(line):
                found[pending] = line
                pending = None
                continue
            if "•" in line or "*" in line:
                masked.append(number)
                pending = None
                continue
        if SECRET_RE.match(line):
            unlabeled.append(number)
    return found, unlabeled, masked


def read_hidden_paste() -> str:
    """Read a pasted block from the terminal with echo disabled until EOF."""
    if not sys.stdin.isatty():
        raise RuntimeError("hidden paste requires a TTY; use ssh -t")
    fd = sys.stdin.fileno()
    attrs = termios.tcgetattr(fd)
    hidden = list(attrs)
    hidden[3] &= ~termios.ECHO
    print("Paste the eBay keys block with its labels. Input is hidden.")
    print("Press Ctrl-D on a new line when finished.\n")
    try:
        termios.tcsetattr(fd, termios.TCSADRAIN, hidden)
        return sys.stdin.read()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, attrs)


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def update_lines(lines: list[str], values: dict[str, str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        match = re.match(r"^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=", line.lstrip())
        if match and match.group(1) in MANAGED:
            key = match.group(1)
            if key in seen:
                continue
            seen.add(key)
            if key in values and values[key] != "":
                out.append(f"{key}={values[key]}")
            elif key != "EBAY_REFRESH_TOKEN":
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
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="local file containing the pasted eBay keys")
    source.add_argument("--paste", action="store_true", help="read the pasted block from the terminal with echo hidden")
    parser.add_argument("--env-file", type=Path, default=Path("/opt/slabswarm/.env"))
    parser.add_argument("--api-env", choices=("sandbox", "production"), default="sandbox")
    args = parser.parse_args()

    try:
        if args.paste:
            text = read_hidden_paste()
        else:
            if not args.input.is_file():
                print(f"ERROR: input file not found: {args.input}", file=sys.stderr)
                return 2
            try:
                text = args.input.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                print("ERROR: input file is not plain text.", file=sys.stderr)
                return 2
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    found, unlabeled, masked = detect(text, args.api_env)
    if "EBAY_CLIENT_ID" not in found or "EBAY_CLIENT_SECRET" not in found:
        missing = [name for name in ("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET") if name not in found]
        print("ERROR: could not identify: " + ", ".join(missing), file=sys.stderr)
        if unlabeled:
            print(
                "Unlabeled value-like lines: " + ", ".join(str(n) for n in unlabeled) +
                ". Add the eBay label before each value and re-run. I will not guess which key is which.",
                file=sys.stderr,
            )
        return 2

    values = dict(found)
    values["EBAY_TOKEN_TYPE"] = "user" if "EBAY_REFRESH_TOKEN" in values else "application"
    values["EBAY_API_ENV"] = args.api_env
    write_private(args.env_file, update_lines(read_lines(args.env_file), values))

    print("Imported fields (values hidden):")
    for key in sorted(values):
        print(f"  {key}")
    print(f"File mode: {oct(stat.S_IMODE(args.env_file.stat().st_mode))}")
    if unlabeled:
        print("Ignored unlabeled lines: " + ", ".join(str(n) for n in unlabeled))
    if masked:
        print("Ignored masked values: " + ", ".join(str(n) for n in masked))
    if not args.paste:
        print("Delete the paste file yourself when done: rm -- " + str(args.input))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
