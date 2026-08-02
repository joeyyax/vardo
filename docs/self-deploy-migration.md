# Migrating Vardo's own stack to the deploy engine

Vardo deploys every other app with blue/green but is itself still deployed by hand:

```
cd /opt/vardo/apps/vardo/env/<standby> && git reset --hard origin/main \
  && docker compose -p vardo build frontend && docker compose -p vardo up -d frontend
```

This moves it onto the product path. Read it end to end before starting.

## What changes

`docker-compose.yml` marks `postgres`, `redis`, `traefik` and `wireguard` with `x-vardo-shared: true`. Those four stay in compose project `vardo`, on the volumes they already have, and are never stopped by a deploy. Only `frontend` rotates.

That is what the manual procedure has always done. The difference is that the engine now understands it.

| | Now | After |
| --- | --- | --- |
| Infra project | `vardo` | `vardo`, unchanged |
| Frontend project | `vardo` | `vardo-production-{blue,green}` |
| Slot dirs | `/opt/vardo/apps/vardo/env/{blue,green}` | `/opt/vardo/apps/vardo/production/{blue,green}` |
| Repo clone | in the slot dir | `/opt/vardo/apps/vardo/repo` |
| Infra volumes | `vardo_postgres_data`, … | unchanged |
| Infra container names | `vardo-postgres`, … | unchanged |
| Updated by | `vardo update` | the dashboard / API |

The shared project is pinned by the compose file's top-level `name: vardo`, so **no volume is renamed and no data is copied**. `traefik_dynamic` is mounted by both a shared service and the frontend, so it becomes an external volume — under the name it already has.

`frontend` publishes no host ports, so the two slots overlap: the new one is healthy and serving before the old one stops.

## Before you start

Take a database backup and confirm it restores. Nothing below deletes data, but the engine writes to `system_settings` and `app` during a deploy.

Note the live slot, for rollback:

```
docker ps --filter name=vardo-frontend \
  --format '{{.Label "com.docker.compose.project.working_dir"}}'
```

## The first cutover cannot be driven by the dashboard

The frontend is the deploy engine. Asking it to replace itself through the API means the process writing deploy logs is the one being stopped — the deploy record is left `running` and the log truncated at the swap.

Steps 1 to 4 are therefore run by hand over SSH. They are the same commands the engine issues; you stand in for it once. From step 5 the dashboard drives.

## Procedure

### 1. Lay out the directories the engine expects

```
mkdir -p /opt/vardo/apps/vardo/production/blue
git clone https://github.com/joeyyax/vardo /opt/vardo/apps/vardo/repo
cd /opt/vardo/apps/vardo/repo && git checkout main
```

If `repo` already exists, `git fetch origin && git reset --hard origin/main` instead.

The frontend container runs as root, so ownership does not matter here — `ensureWritableDir` only chowns when it hits `EACCES`.

### 2. Stage the slot

Copy the runtime files the engine would place there:

```
cd /opt/vardo/apps/vardo/production/blue
cp /opt/vardo/apps/vardo/env/current/.env .
cp /opt/vardo/apps/vardo/repo/docker-compose.yml .
```

The `.env` is not optional: `frontend` sits behind a `production` profile, and `COMPOSE_PROFILES` lives in that file. Run from a directory without it and compose reports no such service.

Confirm the copy took before going on:

```
docker compose -p vardo-production-blue config --services   # must list frontend
```

### 3. Start the new frontend in its slot

```
cd /opt/vardo/apps/vardo/production/blue
docker compose -p vardo-production-blue build frontend
docker compose -p vardo-production-blue up -d --no-deps frontend
```

`--no-deps` is required. Without it compose starts `postgres`, `redis`, `traefik` and `wireguard` *into the slot project* — a second database on a fresh volume, and a second Traefik that cannot bind 443.

The shared services need no action: they are already running under project `vardo`.

Confirm the new frontend before touching the old one — both are up, and Traefik treats them as two backends of one service, so check it directly:

```
docker exec vardo-production-blue-frontend-1 \
  node -e "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(console.log)"
```

Expect `{"status":"ok","services":{"postgres":"ok","redis":"ok"}}`. If not, go to Rollback — the old frontend never stopped.

### 4. Retire the old frontend

```
docker rm -f vardo-frontend
ln -sfn /opt/vardo/apps/vardo/production/blue /opt/vardo/apps/vardo/production/current
```

The symlink is how `detectActiveSlot` finds the live slot, so the next deploy picks `green`.

Load the dashboard. If it answers, the cutover is done.

### 5. Hand over to the engine

`vardo` is now an ordinary app. Deploy it from the dashboard and watch the log. It should report `Active slot: blue, deploying to: green`, `No published host ports — blue keeps serving until green is healthy`, and never mention postgres, redis, traefik or wireguard.

### 6. Stop using `vardo update`

`vardo update` in `install.sh` still targets project `vardo` and would start a competing frontend on the same domain. Remove it from the host once the engine is driving.

The old `env/` directory can be deleted after a successful engine deploy, but there is no hurry — nothing reads it.

## Rollback

Nothing is renamed, copied or deleted, so rollback is starting the old frontend again.

Before step 4, while `vardo-frontend` is still running:

```
docker rm -f vardo-production-blue-frontend-1
```

That is the whole rollback.

After step 4:

```
cd /opt/vardo/apps/vardo/env/<the slot that was live before>
docker compose -p vardo up -d --no-deps frontend
docker rm -f vardo-production-blue-frontend-1
rm -f /opt/vardo/apps/vardo/production/current
```

The shared services run throughout either way, so the database is never in question.

## Risk

**Downtime is one frontend swap, not an outage.** Traefik, Postgres, Redis and WireGuard keep running, so tenant apps are unaffected.

Residual risks:

- **Step 3 leaves two frontends against one database briefly.** Same commit, so the schema matches, and it is the same overlap every app deploy already has. A release carrying a migration is the exception — for those, do step 4 before step 3 and accept the gap.
- **A failed build in step 3** leaves a stopped container. Harmless; the next deploy's pre-clean removes it.
- **`vardo update` run out of habit** starts a second frontend competing for the domain. That is what step 6 is for.
