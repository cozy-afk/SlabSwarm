# eBay credential entry

Use the local hidden-prompt script. Do not paste keys into chat, tickets, docs or browser forms.

```bash
python3 /opt/slabswarm/scripts/set-ebay-keys.py
```

Over SSH, force a TTY:

```bash
ssh -t <host> 'python3 /opt/slabswarm/scripts/set-ebay-keys.py'
```

The script asks for client ID, client secret, optional refresh token and API environment. It writes only those variables to `/opt/slabswarm/.env`, replaces the file atomically, and keeps mode 0600. Default environment is sandbox. Leave the refresh token blank for application-token mode.

A scratch target can be used for testing:

```bash
python3 /opt/slabswarm/scripts/set-ebay-keys.py --env-file /path/to/test.env
```

Verified with fake credentials on a scratch file: prompts did not echo secrets, file mode was 0600, and only the five managed keys appeared in the output summary.

This script does not enable an eBay feed. It only stores credentials. Marketplace Insights and price derivation still need written eBay permission and Buy API approval.

## Importing a pasted block

No file is needed. Copy the whole keys block from eBay, including its labels, and run:

```bash
python3 /opt/slabswarm/scripts/import-ebay-keys.py --paste
```

Paste the block, then press Ctrl-D on a new line. The input is hidden while you type; nothing is echoed and no paste file is created. Over SSH, use `ssh -t` so a TTY is available.

The importer recognizes labels such as `Client ID`, `App ID`, `Cert ID`, `Client secret` and `Refresh token`. It writes the same private `.env` with mode 0600 and reports only field names. It refuses unlabeled blobs and tells you which line numbers need labels; it will not guess which key is which. The older `--input FILE` mode still works if you already have a local file.
