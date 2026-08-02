# Migrating Vardo's own stack to the deploy engine

Vardo used to be the one app deployed by hand:

```
cd /opt/vardo/apps/vardo/env/<standby> && git reset --hard origin/main \
  && docker compose -p vardo build frontend && docker compose -p vardo up -d frontend
```

This is the procedure that moved it onto the product path. It was run against production on 2 August 2026.

## What changes

`docker-compose.yml` marks `postgres`, `redis`, `traefik` and `wireguard` with `x-vardo-shared: true`. Those four stay in compose project `vardo`, on the volumes and networks they already have, and are never stopped by a deploy. Only `frontend` rotates, into `vardo-production-blue` and `vardo-production-green`.

That is what the manual procedure always did. The difference is that the engine now understands it.

| | Before | After |
| --- | --- | --- |
| Infra project | `vardo` | `vardo`, unchanged |
| Frontend project | `vardo` | `vardo-production-{blue,green}` |
| Slot dirs | `/opt/vardo/apps/vardo/env/{blue,green}` | `/opt/vardo/apps/vardo/production/{blue,green}` |
| Infra volumes and networks | `vardo_*` | unchanged |
| Infra container names | `vardo-postgres`, … | unchanged |
| Updated by | `vardo update` | the dashboard / API |

The shared project is pinned by the compose file's top-level `name: vardo`, so **no volume, network or container is renamed and no data is copied**.

## The dashboard can drive this

An earlier draft of this document claimed it could not, on the grounds that the frontend is the deploy engine and would be stopping itself. That turned out to be wrong, for a load-bearing reason:

`detectActiveSlot` looks for slot containers and a `current` symlink under `production/`. Before the migration there are none, so the engine sees **no active slot and stops nothing**. It builds the new frontend into `vardo-production-blue`, starts it alongside the old one, and finishes. The old `vardo-frontend` is in a project the engine does not know about, so it survives.

You then remove the old container yourself. That is the only manual step.

## Before you start

Take a database backup and confirm it restores.

Note the live slot, for rollback:

```
docker ps --filter name=vardo-frontend \
  --format '{{.Label "com.docker.compose.project.working_dir"}}'
```

## Procedure

### 1. Deploy Vardo from the dashboard

Switch to the organization that owns the `vardo` app — it is not necessarily your active one, and the app page 404s from the wrong org. Then **Redeploy stack**.

Watch the log. It should say:

```
Active slot: none, deploying to: blue
Externalized 1 volume(s): traefik_dynamic → vardo_traefik_dynamic
Shared network(s): internal, mesh
Seeded slot .env from /opt/vardo/apps/vardo/env/current/.env
Shared services (not rotated): postgres, redis, traefik, wireguard
  Container vardo-traefik Running
  Container vardo-postgres Running
  ...
```

`Running`, not `Recreated`, is the line that matters — the shared services were left alone.

### 2. Verify the new frontend before touching the old one

Both are up, and Traefik treats them as two backends of one service, so check the new one directly:

```
docker exec vardo-production-blue-frontend-1 \
  node -e "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(console.log)"
```

Expect `{"status":"ok","services":{"postgres":"ok","redis":"ok"}}`.

Confirm Traefik has picked it up:

```
docker exec vardo-traefik wget -qO- http://localhost:8080/api/http/services \
  | python3 -c "import sys,json;[print(s['name'],len(s.get('loadBalancer',{}).get('servers',[]))) for s in json.load(sys.stdin) if 'vardo' in s['name']]"
```

`vardo@docker 2` means both are serving. If anything above fails, go to Rollback — the old frontend never stopped.

### 3. Retire the old frontend

```
docker rm -f vardo-frontend
```

Traefik drops to one backend within a second or two. The `current` symlink was already written by the deploy, so the next one picks the other slot.

### 4. Confirm

```
docker ps --format '{{.Names}}\t{{.Status}}' | grep vardo
curl -o /dev/null -w '%{http_code}\n' https://<your-domain>/login
```

The four shared services should still show their pre-migration uptime.

### 5. Clean up

The slot project creates empty copies of volumes declared in the compose but mounted only by shared services. They are unused — the real data stays in `vardo_*` — but they are clutter:

```
docker volume rm vardo-production-<slot>_postgres_data \
                 vardo-production-<slot>_redis_data \
                 vardo-production-<slot>_wireguard_config
```

Do not remove anything named `vardo_*`. That is the live data.

### 6. Stop using `vardo update`

`vardo update` in `install.sh` still targets project `vardo` and would start a second frontend competing for the domain. Remove it from the host.

The old `env/` directory can be deleted once you have deployed successfully from the dashboard.

## Rollback

Nothing is renamed, copied or deleted, so rollback is starting the old frontend again.

Before step 3, while `vardo-frontend` is still running:

```
docker rm -f vardo-production-<slot>-frontend-1
```

That is the whole rollback. The old container never stopped.

After step 3:

```
cd /opt/vardo/apps/vardo/env/<the slot that was live before>
docker compose -p vardo up -d --no-deps frontend
docker rm -f vardo-production-<slot>-frontend-1
rm -f /opt/vardo/apps/vardo/production/current
```

The shared services run throughout either way, so the database is never in question.

## Risk

**Downtime is one frontend swap, not an outage.** Traefik, Postgres, Redis and WireGuard keep running, so tenant apps are unaffected. Measured on the real migration: no failed request.

Residual risks:

- **Step 1 leaves two frontends against one database briefly.** Same commit, so the schema matches, and it is the overlap every app deploy already has. A release carrying a migration is the exception — for those, do step 3 before step 2 and accept the gap.
- **A failed deploy leaves a stopped container and an empty volume.** Harmless; the next deploy's pre-clean removes the container, and step 5 covers the volume.
- **`vardo update` run out of habit** starts a competing frontend. That is what step 6 is for.
