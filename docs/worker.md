# Worker

`vardo-worker` runs Vardo's background loops and every app deploy and build: backups, cron, container health, alerts, metrics collection and the rest of `lib/worker/registry.ts`. It's the console's image with `command: ["worker"]`, in the same slot, so a deploy of Vardo replaces both together.

Deploys of Vardo itself, git polling and self-updates still run in the console.

## Deploys

A deploy is a row in the `deployment` table. Whatever asks for one (the deploy button, the API, a push, a poll, a restore) inserts it as `queued` and returns. Executors claim queued rows from Postgres once a second:

| Process | Claims |
| --- | --- |
| Worker | Every deploy except Vardo's own |
| Console | Vardo's own deploys |
| Console with `VARDO_DEPLOY_EXECUTOR=web` | Every deploy; the worker claims none |
| Console with `VARDO_WORKER=embedded` (`pnpm dev`) | Every deploy |

- **One per app environment.** A second deploy of the same environment waits for the first. A push or poll replaces an older push still queued, and stops a running push during clone, compose or build. A deploy from the button or the API never stops a running one; it runs next.
- **Capacity.** Running deploys across the host stay at or under the deploy concurrency setting. Explicit deploys are claimed before pushes.
- **Leases.** The executor renews each claim every 3 seconds. A claim expires 45 seconds after its executor stops renewing it.
- **Cancel.** A queued deploy is cancelled at once. A running one stops within seconds while it clones or builds; past that it stops at the next stage.
- **Crash rule.** When a lease expires during clone, compose or build, the deploy is requeued once with a log line saying so; a second expiry fails it. Expiring later than the build fails it, and `deploy-sweep` stops its slot only if nothing serves.
- **Time limits.** A deploy running past `DEPLOY_TIMEOUT_MINUTES` (45) is asked to stop. Pushes and polls still queued after 24 hours are cancelled. Other queued deploys wait as long as it takes.
- **Fence.** Before the swap touches containers, the deploy checks it still holds its claim. A lost claim stops it with the old slot serving.
- **Project deploys and previews** run as `deploy-group` jobs in the `worker_job` table. The job queues each tier's deploys and waits on them.

### Vardo's own deploys

A deploy of Vardo queues and builds like any other. Its swap restarts the worker and console and can recreate Postgres and Redis, so before the swap it sets a hold on its row: executors claim nothing new, and the deploy waits up to 15 minutes for running deploys, logging `Waiting for N deploys to finish before the swap` every 30 seconds. Deploys still running at 15 minutes get the old worker's drain, then the crash rule. A successful deploy keeps the hold until the new slot's console or worker clears it; a failed one drops it. A hold older than 30 minutes stops counting.

### When the worker is down

Deploys queue. The deploy log says `Waiting for the worker`, and every page shows how many deploys are waiting. `host.worker-down` opens after 3 minutes. An automatic update still goes ahead, since queued deploys don't count as busy, so a release that fixes the worker can land.

If the worker can't boot, set `VARDO_DEPLOY_EXECUTOR=web` in `/opt/vardo/.env` and redeploy: the console runs every deploy until it's removed.

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
| `503 unhealthy` | Database unreachable, or the deploy claim, deploy sweep, backup tick, cron tick or container health loop stopped beating |

`vardo worker status` prints the container state and this response. `vardo logs worker` follows its logs.

## Stopping

SIGTERM stops claiming at once and lets running passes, deploys and backup work finish for up to `VARDO_WORKER_DRAIN_SECONDS` (540), renewing deploy leases meanwhile, then hands each loop's lease back. A deploy still running after that loses its lease, and the crash rule takes it. `stop_grace_period` is 10 minutes.

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
| `VARDO_DEPLOY_EXECUTOR` | Unset. `web` makes the console run every deploy and the worker none. For this release only. |

## Development

`pnpm dev` runs every loop itself. For the production split, set `VARDO_WORKER=external` in `.env` and run `pnpm dev:worker` next to `pnpm dev`.

## What web still needs from the loops

A loop that moves to the worker takes its in-process side effects with it. Stage 2 lost the metrics provider this way: only the collector set it, so web's live stats had none. Audit of every loop that can run in the worker:

| Loop | Side effect | Status |
| --- | --- | --- |
| `metrics-collector` | Sets the metrics provider web's stats streams poll | Fixed: `instrumentation.ts` sets it |
| `metrics-collector` | GPU snapshot merged into live stats frames | Fixed: published to Redis (`metrics:gpu:snapshot`) |
| `metrics-collector` | Latest container snapshot | Safe: only the alert pass reads it, and it moves with the collector |
| `metrics-collector`, `error-rate` | Time series, disk usage, error rates | Safe: Redis |
| `metrics-orphan-sweep` | Web deletes an app's series, but the worker's created-keys cache still lists them | Fixed: the cache expires after 10 minutes and re-applies labels and retention |
| `system-alerts` | Fired-alert state the settings page shows | Fixed: the route reads the persisted row |
| `system-alerts` | OOM and anomaly-quiet hooks fill per-process maps, so OOMs web emits during deploys never reach the worker's alert pass | Fixed: kills go to Redis hashes for the hold window (`alerts:oom:*`) and activity to a sorted set for the quiet grace (`vardo:anomaly-quiet`); each process keeps its own copy for when Redis is down |
| `image-update-*`, `digest` | EOL table, refreshed by `image-eol-sync` in web | Fixed: the worker loads the stored table at boot; refreshes reach it on its next restart |
| `rollback-watch` | GitHub PR feedback rows live in the memory of the process that tracked the deploy, so a worker rollback rewrites the comment from an empty map | Fixed: each comment's rows, SHA, comment id and merged PR are in a Redis hash (`github:feedback:*`) for the rollback watch window |
| `backup-*`, `restore-drill` | Self-deploy drain reads web's in-flight backups, so it doesn't see or pause the worker's | Fixed: beacons record their slot; the drain waits on the old slot's `backup:busy:*` keys and sets `backup:drain:<slot>`, which pauses that slot's schedules |
| `backup-*` | Boot steps only web runs (credential encryption, interrupted-backup reap, backup target) and `after: "backup-target"`, which the worker never waits on | Fixed: web records each release's boot steps in `system_settings` (`backup_boot:<sha>`) and the worker's backup loops wait for it; the boot reap spares rows under a minute old |
| `container-health`, `status-reconcile` | Self-heal and OOM state | Safe: the readers run in the same loops; self-heal is mirrored to Postgres |
| `cert-export` | Written-cert maps | Safe: web's deploy path keeps its own; a race on one volume rewrites the same files |
| `probe-guard`, `cloudflare-only-sync` | Traefik files on the shared volume | Safe: each write renders the whole file from Postgres |
| Every loop | `emit()` events, loop heartbeats, leases, settings | Safe: Redis streams and Postgres |
| The rest | Postgres, Redis, Docker or files only | Safe |

The event, notification, deploy, log and terminal streams read Redis or Docker directly, so they don't depend on a loop's process.

### Shared backup and alert state

- **Self-deploy drain.** The old console waits up to `VARDO_BACKUP_DRAIN_MINUTES` for backup work in its own process and in the old slot's worker, and the worker starts no new backups meanwhile. A busy key lapses 30 seconds after its process dies and the drain flag 30 seconds after the old console stops. With Redis down the drain waits on the old console's own work only, and the worker's SIGTERM drain covers its own.
- **Worker boot.** The worker's backup loops wait for the console to record credential encryption and the backup target for the same release. Until then the worker reports `booting`, so the console keeps its backup loops.
- **OOM alerts and quiet windows.** Kills and restarts any process sees reach the alert pass wherever it runs. A kill Redis refuses is retried for a minute.

### Post-deploy stream check

After a deploy of Vardo itself, the old console opens the new console's org, project and app stats streams and waits up to 20 seconds for a `point` event on each. It signs in with a read-only API token that lasts 2 minutes and is deleted afterward. A stream that sends nothing marks the deploy's post-deploy work unfinished and notifies, with `[smoke]` lines in the deploy log. It skips when metrics or API tokens are off.
