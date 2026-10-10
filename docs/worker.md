# Worker

`vardo-worker` runs Vardo's background loops: backups, cron, container health, alerts, metrics collection and the rest of `lib/worker/registry.ts`. It's the console's image with `command: ["worker"]`, in the same slot, so a deploy of Vardo replaces both together.

Deploys, git polling and self-updates still run in the console.

## How the console hands off

The worker writes a heartbeat to the `worker` table every 10 seconds. Every 30 seconds the console checks it:

- A ready worker beat in the last 90 seconds: the console stops its own copies of those loops and logs `Loops deferred to worker`.
- No such worker for 2 minutes: the console runs them again.

Loops that serve one process, like config sync, stay in the console either way.

## Health

`GET http://localhost:3001/healthz` inside the container, which Docker's healthcheck and so the [watchdog](watchdog.md) read.

| Status | Meaning |
| --- | --- |
| `200 ok` | Booted, database and Redis reachable |
| `200 degraded` | Redis is down |
| `200 draining` | Finishing work after SIGTERM or a drain request |
| `503 booting` | Waiting for the console to apply this release's migrations |
| `503 unhealthy` | Database unreachable, or the deploy sweep, backup tick, cron tick or container health loop stopped beating |

`vardo worker status` prints the container state and this response. `vardo logs worker` follows its logs.

## Stopping

SIGTERM stops new passes, lets running ones and backup work finish for up to `VARDO_WORKER_DRAIN_SECONDS` (540) and hands each loop's lease back. `stop_grace_period` is 10 minutes.

## Incidents

| Incident | Opens when |
| --- | --- |
| `host.worker-down` | No worker heartbeat for 3 minutes |
| `host.watchdog-silent` | The watchdog hasn't ticked for 10 minutes |
| `host.peer-silent` | A persistent mesh peer hasn't answered for 5 minutes |
| `host.peer-worker-down` | A peer's console reports no worker heartbeat for 3 minutes |
| `host.peer-watchdog-silent` | A peer's watchdog hasn't ticked for 10 minutes |

Each resolves on recovery.

## Settings

Set these in `/opt/vardo/.env` and redeploy.

| Variable | Default |
| --- | --- |
| `VARDO_WORKER_MEM` | A quarter of RAM, between 768m and 1536m. `install.sh` writes it. |
| `VARDO_WORKER_STOP_GRACE` | `10m` |
| `VARDO_WORKER_DRAIN_SECONDS` | `540` |
| `VARDO_LOOPS_IN_WEB` | `auto`. `always` keeps every loop in the console; `never` leaves them to the worker. |
| `VARDO_WORKER` | `external` in production, `embedded` in dev, where `pnpm dev` runs every loop. |

## Development

`pnpm dev` runs every loop itself. For the production split, set `VARDO_WORKER=external` in `.env` and run `pnpm dev:worker` next to `pnpm dev`.
