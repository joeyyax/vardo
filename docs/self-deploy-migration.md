# Migrating Vardo's own stack to the deploy engine

One-time, operator-run procedure. It moves the running Vardo stack off the
hand-rolled `docker compose -p vardo` layout onto the layout the deploy engine
expects, so `vardo` can be deployed like any other app.

**Do not attempt this yet.** Three things in the engine still have to change —
see [Blockers](#blockers). The rest of this document is the procedure for once
they have, and an honest account of what it costs.

## What changes

| | Now | After |
|---|---|---|
| Compose project | `vardo` (all five services) | `vardo-production-shared` (infra) + `vardo-production-{blue,green}` (frontend) |
| Source dir | `/opt/vardo/apps/vardo/env/{blue,green}` | `/opt/vardo/apps/vardo/production/{blue,green}` |
| Repo clone | same dir as the slot | `/opt/vardo/apps/vardo/repo` |
| Volumes | `vardo_postgres_data`, … | `vardo-production_postgres_data`, … |
| Container names | `vardo-postgres`, `vardo-frontend` | `vardo-production-shared-postgres-1`, … |
| Updated by | `vardo update` (install.sh) | the dashboard / API |

`postgres`, `redis`, `traefik` and `wireguard` carry `x-vardo-shared: true` in
`docker-compose.yml`, so `partitionBySlot` puts them in the shared project.
Only `frontend` gets blue and green copies.

## Blockers

Each of these makes a product-path deploy of `vardo` produce a broken frontend.
None is specific to the migration — they are properties of deploying *this*
compose file through the engine.

1. **`group_add` is dropped by the compose parser.** The frontend needs
   `group_add: ${DOCKER_GID}` to write to `/var/run/docker.sock`. Without it the
   redeployed Vardo cannot talk to Docker, which means it cannot deploy anything
   — including a fix for itself.
2. **`container_name` is dropped, and the two projects do not share a network.**
   `.env` and the compose `environment` block point at `vardo-postgres` and
   `vardo-redis`. Those hostnames exist only because of `container_name`, and the
   shared project's `internal` network (`vardo-production-shared_internal`) is a
   different network from the slot's. The frontend has no route to its database.
   Reaching it over the injected external `vardo-network` would work, but that
   network is shared with every tenant app on the host — putting Postgres on it
   is a real exposure, not a workaround.
3. **The `mesh` network declares a fixed subnet.** Two compose projects each
   creating a `mesh` network on `10.88.0.0/24` is a pool collision; the second
   one fails to create. Per-service `ipv4_address` is dropped by the parser
   as well, so `WIREGUARD_GATEWAY: 10.88.0.2` stops resolving to anything.

`profiles`, `sysctls` and `mem_limit` are also dropped. Those are cosmetic here
— dropping `profiles` is what makes the frontend start at all — but worth
knowing before you diff a running container against the compose file.

## Before you start

- All three blockers above are fixed and a `vardo` deploy has been rehearsed on
  a throwaway host.
- The `vardo` app row has a non-empty `git_url` and `container_port`:
  `docker exec vardo-postgres psql -U host -c "select git_url, git_branch, container_port from app where name = 'vardo'"`
- You have console or SSH access that does not depend on Traefik.
- The host has free disk for a second copy of the Postgres volume.

## The first cutover cannot be driven by the dashboard

Every later deploy goes through the API. The first one cannot, and it is worth
being clear why rather than discovering it halfway through.

The engine brings the shared services up under `vardo-production-shared`. Those
services publish 80, 443, 7100, 7200 and 51820, which the old `vardo` project is
holding, so the old project has to stop first. Stopping it stops Postgres. The
frontend that would issue the deploy needs Postgres to serve a request at all —
and once Postgres restarts under the new project name it is on a different
network under a different hostname, so the old frontend cannot reconnect to it
either.

So the first cutover is done by hand, running the same commands the engine would
run. From then on the engine owns the layout.

## Procedure

Budget an hour and a maintenance window. Times assume a small database.

### 1. Back up

```bash
cd /opt/vardo/apps/vardo/env/current
docker compose -p vardo exec -T postgres pg_dump -U host host > /opt/vardo/backups/pre-migration.sql
docker run --rm -v vardo_letsencrypt:/src -v /opt/vardo/backups:/dst alpine \
  tar czf /dst/pre-migration-letsencrypt.tgz -C /src .
```

Verify the dump is non-empty before continuing.

### 2. Lay out the new directories

Do this while the old stack is still serving — nothing here touches it.

```bash
install -d -o 1001 -g 1001 /opt/vardo/apps/vardo/production/blue \
                           /opt/vardo/apps/vardo/production/green
git clone https://github.com/joeyyax/vardo /opt/vardo/apps/vardo/repo
chown -R 1001:1001 /opt/vardo/apps/vardo/repo
ln -sfn /opt/vardo/.env /opt/vardo/apps/vardo/production/blue/.env
ln -sfn /opt/vardo/.env /opt/vardo/apps/vardo/production/green/.env
```

Leave `/opt/vardo/apps/vardo/env/` alone. It is the rollback.

### 3. Build the new frontend image

Also while the old stack is serving, so a build failure costs nothing.

```bash
cd /opt/vardo/apps/vardo/production/blue
cp -a /opt/vardo/apps/vardo/repo/. .
GIT_SHA=$(git -C /opt/vardo/apps/vardo/repo rev-parse --short HEAD) \
  docker compose -p vardo-production-blue build frontend
```

### 4. Stop the old stack

```bash
docker compose -p vardo -f /opt/vardo/apps/vardo/env/current/docker-compose.yml stop
```

`stop`, not `down` — the containers and the `vardo_*` volumes stay on disk,
which is what makes the rollback possible.

**Downtime starts here.** The dashboard and every app routed through Traefik are
offline until step 6.

### 5. Copy the volumes to their new names

The engine externalizes named volumes to `vardo-production_<name>` and creates
them empty, so the data has to be in place first.

```bash
for v in postgres_data redis_data letsencrypt wireguard_config traefik_dynamic; do
  docker volume create "vardo-production_$v"
  docker run --rm -v "vardo_$v":/from -v "vardo-production_$v":/to alpine \
    sh -c 'cd /from && cp -a . /to'
done
```

Copy, do not move. The originals are the rollback.

### 6. Start the shared project, then the blue slot

```bash
cd /opt/vardo/apps/vardo/production/blue
docker compose -p vardo-production-shared up -d --no-deps postgres redis traefik wireguard
docker compose -p vardo-production-blue up -d --no-deps --pull never frontend
ln -sfn blue /opt/vardo/apps/vardo/production/current
```

Traefik is back, so unrelated apps recover at the first command. Wait for
`vardo-production-blue-frontend-1` to report healthy before continuing.

### 7. Hand over to the engine

Deploy `vardo` once from the dashboard. It should detect `blue` as the active
slot, build into `green`, leave the four shared containers untouched, and cut
over. That deploy is the real test — if it works, the migration is done.

### 8. Retire the old layout

Only after step 7 succeeds:

```bash
docker compose -p vardo -f /opt/vardo/apps/vardo/env/current/docker-compose.yml down
```

Keep `/opt/vardo/apps/vardo/env/` and the `vardo_*` volumes for at least a week.
Delete them in a separate change once you trust the new layout.

## Rollback

Before step 8 the old stack is intact and three commands away:

```bash
docker compose -p vardo-production-blue down --remove-orphans
docker compose -p vardo-production-shared down --remove-orphans
docker compose -p vardo -f /opt/vardo/apps/vardo/env/current/docker-compose.yml up -d
```

The `vardo_*` volumes were only ever read from, so nothing is lost. Discard the
`vardo-production_*` copies and try again another day.

After step 8 the same commands work, but the old containers are gone and
`up -d` recreates them from the compose file — expect a minute or two longer.

If Postgres will not start under either layout, restore
`/opt/vardo/backups/pre-migration.sql` into a fresh `vardo_postgres_data`.

## Risk

**There is no zero-downtime path, and the outage covers every app on the host,
not just the dashboard.**

Between steps 4 and 6, Traefik is down, so every tenant app loses its route.
Three constraints force this and none of them is negotiable:

- **The volume prefix is fixed.** `build.ts` derives it from `<app>-<env>`, so
  the Postgres volume has to be copied to a new name. Copying a live database is
  not safe, so Postgres stops first.
- **The project name is fixed.** Slot and shared projects are
  `<app>-<env>-<slot>` and `<app>-<env>-shared`. The running stack is `vardo`.
  Docker will not let the new projects claim ports 80, 443, 7100, 7200 and 51820
  while the old one holds them.
- **The cutover is self-referential.** The frontend is the deploy engine, so it
  cannot be the thing that performs its own first migration. Hence the manual
  step 6, and hence the manual rollback being the only real safety net.

Two further hazards:

- `vardo update` (install.sh) still targets `/opt/vardo/apps/vardo/env/` and
  project `vardo`. Run it after the migration and it starts a second frontend
  competing for the same domain. It needs to be taught the new layout, or
  removed, before anyone reaches for it out of habit.
- The `vardo` app row is `is_system_managed`, and the rollback, instant-rollback,
  restart, stop and recreate API routes all refuse system-managed apps. Deploy
  is the only product-path verb available, so a bad deploy has to be undone by
  hand. Worth resolving before the first real self-deploy.
