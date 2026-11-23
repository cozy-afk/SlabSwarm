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
