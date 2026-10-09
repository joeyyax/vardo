# Watchdog

`vardo-watchdog` restarts Vardo's core containers when Docker reports them unhealthy. Docker's `restart: unless-stopped` only acts when a container exits, and the console's own health monitor can't help when the console is the one that's wedged.

It's a shell script (`scripts/watchdog.sh`) on the stock `docker:cli` image. It has no network, no database and no Redis client: everything goes through the Docker socket.

## What it watches

Every 30 seconds it reads Docker's health status for:

| Container | Restarted after |
| --- | --- |
| The active console slot | 3 unhealthy checks in a row (90s) |
| `vardo-traefik` | 3 unhealthy checks in a row (90s) |
| `vardo-postgres` | 10 unhealthy checks in a row (5 min) |
| `vardo-redis` | 10 unhealthy checks in a row (5 min) |

The console slot comes from `/opt/vardo/apps/vardo/production/current`. Without that symlink it watches `vardo-frontend`.

A container that isn't running is left to Docker's restart policy. A container with no healthcheck is never restarted.

## When it holds off

- **During a deploy.** Any `deploy:active:*` lease in Redis means a deploy or rollback is running, and the count starts over.
- **When it can't read Redis.** The console and Traefik wait, since a missing Redis is usually why they're unhealthy. Postgres and Redis still restart after their 5-minute window.
- **After 3 restarts in 30 minutes** of one container. It logs a backoff and tries again once the oldest restart ages out.
- **While `/opt/vardo/watchdog/pause` exists.** Touch it for maintenance.

## Where it reports

Each restart, failed restart and backoff goes to `docker logs vardo-watchdog` and to `/opt/vardo/watchdog/events.log`. The console reads that file every minute and sends each new entry as a **Service degraded** alert, so a restart made while the console was down shows up once it's back.

## Settings

Set these in `/opt/vardo/.env` and redeploy the console.

| Variable | Default |
| --- | --- |
| `VARDO_WATCHDOG` | `true`. `false` leaves the container idle. |

The script also reads `WATCHDOG_INTERVAL`, `WATCHDOG_APP_FAILS`, `WATCHDOG_DATA_FAILS`, `WATCHDOG_MAX_RESTARTS` and `WATCHDOG_WINDOW` from its own environment.

## Rollout

- **Self-deployed installs:** the next console deploy starts it as a shared service, next to Traefik and Postgres.
- **Installs updated with `vardo update`:** the update starts it.
- **Fresh installs:** `install.sh` starts it with the rest of the stack.

To start it by hand on an install that isn't self-deployed: `docker compose -f /opt/vardo/apps/vardo/env/current/docker-compose.yml up -d --no-deps watchdog`.
