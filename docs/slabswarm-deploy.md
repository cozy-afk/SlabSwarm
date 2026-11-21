# SlabSwarm self-hosted deploy (OCI A1, Docker)

Live target: `oci-a1-ams` (Ubuntu 26.04 arm64, Docker 29.1.3, Compose 2.40.3).
Deploy dir: `/opt/slabswarm`. Container port 3000 is published on host `10.99.0.1:3010`
because port 3000 is already occupied by another container.

## Files

- `Dockerfile` - Node 22 slim base, native arm64 build, installs deps, builds Vite
  frontend, runs Express via `tsx`. No secrets in the image.
- `docker-compose.yml` - restart policy, log rotation, healthcheck, `.env` bind mount,
  `data/` bind mount for the JSON graph store.
- `docker/entrypoint.sh` - boot gate: verifies node/tsx/dist and data-dir writability,
  reports key status without printing values, then `exec`s the server.
- `docker/enter-keys.sh` - host-side interactive key entry, then force-recreates the
  container so env changes take effect.

## First boot

```bash
ssh oci-a1-ams
sudo mkdir -p /opt/slabswarm && sudo chown ubuntu:ubuntu /opt/slabswarm
cd /opt/slabswarm
git clone https://github.com/cozy-afk/SlabSwarm.git .
cp .env.example .env          # placeholder values only; no real secrets committed
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs -f slabswarm
```

Good logs end with `[slabswarm] starting server on port 3000`. The app logs
`[slabswarm] Gemini key: MISSING` on a keyless boot; that is expected and is not a
failure. Bad config (missing dist, unwritable data dir) exits non-zero and the restart
policy retries with the error in logs.

## Entering keys

```bash
cd /opt/slabswarm
bash docker/enter-keys.sh
```

Choose quick entry for `GEMINI_API_KEY` plus optional admin passcode/session secret,
or the full editor for every variable. The script force-recreates the container so the
new environment is loaded. Verify:

```bash
sudo docker compose logs --tail=30 slabswarm
curl -fsS http://10.99.0.1:3010/api/health
```

`GEMINI_MODEL` defaults to `gemini-2.5-flash` in the quick-entry path. The scaffold's
`gemini-4-hydrogen` / `gemini-embedding-2` values look like generator placeholders;
replace them with model IDs your key actually has access to before expecting LLM
features to work.

## Runs on its own

- `restart: unless-stopped` plus Docker daemon enabled at boot. No human login needed.
- State is `/opt/slabswarm/data/slabgraph-db.json` on the host. It survives container
  rebuilds. Back it up by copying that directory.
- Nothing is scheduled. Updates are a deliberate human step.

## Update

```bash
cd /opt/slabswarm
git pull --ff-only
sudo docker compose up -d --build
```

## Known gaps

- No Docker on the Windows dev box; the first real image build happens on the target.
- No domain or reverse-proxy route was added. Caddy lives at
  `/home/hermes/homelab/reverse-proxy/Caddyfile` and is shared with other services;
  adding `slabswarm.144-21-43-141.sslip.io` is a separate, deliberate change.
- OCI ingress rule for port 3010 was not verified. If `curl` from the internet fails,
  open the port in the OCI security list or add the Caddy route over 443.
- LLM, alert, and Hermes integrations are untested until real keys are entered.
