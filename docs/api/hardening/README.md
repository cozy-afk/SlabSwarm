# Operational hardening — proposals (Task 3)

Status: **proposals only**. The productization lane did not change deployment
files, listeners, firewall or DNS. Implementers: integrator / owner.

## Memory limits (proposal)

`docker-compose.yml` currently declares one service (`slabswarm`) with **no**
`mem_limit` and no `deploy.resources.limits`. Add bounded memory to the
`slabswarm` service and to every Phase 4 persistence container (Postgres 17,
Parquet-lake sidecars) before deploy, e.g.:

```yaml
deploy:
  resources:
    limits:
      memory: 1g        # slabswarm app
    reservations:
      memory: 256m
```

Suggested starting points (tune after one production cycle): app `1g`,
Postgres `2g`, any DuckDB/analytics job `1g`. Keep the `json-file` log cap that
is already present (`max-size: 10m`, `max-file: 3`). Do not expose new ports.

## Backup / restore drill

- `backup.sh` — dumps Postgres (`pg_dump -Fc`), archives the Parquet lake,
  copies server-side settings with `0600`, writes `SHA256SUMS`. All Docker
  calls use `sudo -n docker`.
- `restore-drill.sh` — verifies checksums, restores into a throwaway DB and a
  temp lake directory, then drops the drill DB. Never writes to production
  canonical data. Both are artifacts; **run them on a schedule only after
  owner approval**, and store backups off-host.

## Audit log notes (proposal)

There is no canonical-write audit trail in the current server. Add an
append-only audit record for every canonical write (evidence append, identity
resolution, observation normalization, forecast score, learning promotion),
carrying actor, `requestId`, target id, before/after digest, `capturedAt`, and
basis. Route to the existing `json-file` Docker log driver (already capped)
or a dedicated append-only file under `SLABGRAPH_DATA_DIR`. Never log secret
values; credentials remain server-side. Raw evidence stays immutable and
corrections append — the audit log follows the same rule.

## Internal listeners to review (no firewall changes)

| Surface | Location | Note |
| --- | --- | --- |
| Express app | `server.ts:2115` `app.listen(PORT, '0.0.0.0')` → 3000 | Published only to `10.99.0.1:3010` in compose. Keep the shared gate and internal bind; do not publish publicly. |
| Vite dev server | `server.ts:2102` `createViteServer` | Dev-only; confirm it is not started under `NODE_ENV=production`. |
| Hermes webhook gateway | documented at `server/hermesBridge.ts:136,142` (port 8644) | External Hermes process config snippet, not a listener in this repo. Verify it binds loopback/internal and that `WEBHOOK_SECRET` is set server-side. |
| Postgres 17 (Phase 4) | persistence lane | Must bind the internal Docker network / loopback only, never `0.0.0.0` on the host. |
| Health endpoint | `GET /api/health` | Internal, used by compose healthcheck at `127.0.0.1:3000`. No change. |

**No new public listeners were introduced.** Keep all existing shared-gate and
internal binds exactly as-is; any change needs explicit owner approval.
