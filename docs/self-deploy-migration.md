# Migrating Vardo's own stack to the deploy engine

One-time, operator-run procedure. It moves the running Vardo stack off the
hand-rolled `docker compose -p vardo` layout and onto the slot layout the deploy
engine expects, so `vardo` can be deployed like any other app.

Read the whole document first. This requires downtime and there is no way to
avoid it — see [Risk](#risk).

## What changes

| | Now | After |
|---|---|---|
| Compose project | `vardo` (all five services) | `vardo` (shared infra) + `vardo-production-{blue,green}` (frontend) |
| Source dir | `/opt/vardo/apps/vardo/env/{blue,green}` | `/opt/vardo/apps/vardo/production/{blue,green}` |
| Repo clone | same dir as the slot | `/opt/vardo/apps/vardo/repo` |
| Volumes | `vardo_postgres_data`, … | `vardo-production_postgres_data`, … |
| Updated by | `vardo update` (install.sh) | the dashboard / API |

`postgres`, `redis`, `traefik` and `wireguard` carry `x-vardo-shared: true` in
`docker-compose.yml`. They are deployed once and never rotated. Only `frontend`
gets blue and green copies.

## Before you start

These must be true or the migration will strand you with no dashboard.

- The deploy engine honors `x-vardo-shared`. If a deploy of `vardo` still builds
  postgres/redis/traefik/wireguard into the slot project, stop here.
- The `vardo` app row has a non-empty `git_url`. Check in the dashboard, or:
  `docker exec vardo-postgres psql -U host -c "select name, git_url, git_branch, container_port from app where name = 'vardo'"`
- You have console or SSH access that does not depend on Traefik.
- The host has enough free disk for a second copy of the Postgres volume.

## Procedure

Times assume a small database. Budget 30 minutes and a maintenance window.

### 1. Back up

```bash
cd /opt/vardo/apps/vardo/env/current
docker compose -p vardo exec -T postgres pg_dump -U host host > /opt/vardo/backups/pre-migration.sql
docker run --rm -v vardo_letsencrypt:/src -v /opt/vardo/backups:/dst alpine \
  tar czf /dst/pre-migration-letsencrypt.tgz -C /src .
```

Verify the dump is non-empty before continuing.

### 2. Stop the stack

```bash
docker compose -p vardo stop
```

`stop`, not `down` — the containers and the `vardo`-prefixed volumes stay on
disk, which is what makes step 6 possible.

Downtime starts here. The dashboard and every app that routes through Traefik
are offline until step 5.

### 3. Copy the volumes to their new names

The deploy engine externalizes named volumes to `vardo-production_<name>`. It
creates them empty, so the data has to be there first.

```bash
for v in postgres_data redis_data letsencrypt wireguard_config traefik_dynamic; do
  docker volume create "vardo-production_$v"
  docker run --rm -v "vardo_$v":/from -v "vardo-production_$v":/to alpine \
    sh -c 'cd /from && cp -a . /to'
done
```

Copy, do not move. The originals are the rollback.

### 4. Lay out the new directories

```bash
install -d -o 1001 -g 1001 /opt/vardo/apps/vardo/production/blue \
                           /opt/vardo/apps/vardo/production/green
git clone https://github.com/joeyyax/vardo /opt/vardo/apps/vardo/repo
chown -R 1001:1001 /opt/vardo/apps/vardo/repo
ln -sfn /opt/vardo/.env /opt/vardo/apps/vardo/production/blue/.env
ln -sfn /opt/vardo/.env /opt/vardo/apps/vardo/production/green/.env
```

Leave `/opt/vardo/apps/vardo/env/` alone. It is the rollback.

### 5. Bring the shared services back up

```bash
cd /opt/vardo/apps/vardo/env/current
docker compose -p vardo up -d postgres redis traefik wireguard
```

Traefik is serving again, so unrelated apps recover here. The Vardo dashboard is
still down — nothing is running `frontend`.

### 6. Deploy the frontend through the engine

There is no dashboard to click, so trigger it over the API from the host:

```bash
curl -sN -X POST \
  -H "Authorization: Bearer $VARDO_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://$VARDO_DOMAIN/api/v1/organizations/$ORG_ID/apps/$APP_ID/deploy"
```

Watch the SSE stream. A successful deploy leaves `vardo-production-blue-frontend-1`
running and healthy.

### 7. Confirm, then retire the old layout

Check the dashboard loads, apps list, and a test deploy of some other app works.
Only then:

```bash
docker compose -p vardo rm -f frontend
```

Keep `/opt/vardo/apps/vardo/env/` and the `vardo_*` volumes for at least a week.
Delete them in a separate change once you trust the new layout.

## Rollback

At any point before step 7, the old stack is intact and one command away:

```bash
docker compose -p vardo-production-blue down --remove-orphans
cd /opt/vardo/apps/vardo/env/current
docker compose -p vardo up -d
```

The `vardo_*` volumes were only ever read from, so no data is lost. Discard the
`vardo-production_*` copies and try again later.

After step 7 the rollback is the same, plus recreating the frontend container
from the old slot — which the command above already does.

If Postgres will not start under either layout, restore from
`/opt/vardo/backups/pre-migration.sql` into a fresh `vardo_postgres_data`.

## Risk

**This cannot be done without downtime, and the window is not short.**

The frontend is the deploy engine. It cannot deploy itself while it is stopped,
so the cutover is: stop everything, move data by hand, start infra, then ask the
newly-started frontend to redeploy itself. Between steps 2 and 5 every app on
the host is offline, because Traefik goes down with the project.

The irreducible reasons:

- **The volume prefix is not negotiable.** `build.ts` derives it from
  `<app>-<env>`, so the Postgres data volume has to be copied to a new name.
  Copying a live database is not safe, so Postgres has to stop first.
- **The project name is not negotiable either.** Slot projects are
  `<app>-<env>-<slot>`. The running stack is `vardo`. Docker will not let the new
  project claim host ports 80, 443, 7100, 7200 and 51820 while the old one holds
  them, so the old one has to stop before the new one starts.
- **The last step is self-referential.** If the frontend the engine builds is
  broken, the thing that would roll it back is that same broken frontend. The
  manual rollback above is the only real safety net.

Two further hazards to be aware of:

- `vardo update` (install.sh) still targets `/opt/vardo/apps/vardo/env/` and
  project `vardo`. Running it after the migration starts a second frontend that
  fights the slot project for the same domain. Do not run it again once you have
  cut over.
- The engine's compose parser drops `container_name`, `group_add` and per-network
  `ipv4_address`. A frontend deployed through the product path therefore loses
  its docker-socket group membership and its fixed mesh address, and the
  `vardo-postgres` / `vardo-redis` hostnames its `.env` points at only exist
  because of `container_name`. Confirm those are handled before you attempt this.
