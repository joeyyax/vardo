# Vardo deploys itself

Vardo runs its console as an app, `vardo`, deployed by its own engine. Fresh installs end in this layout, and `vardo migrate-self-deploy` moves an older install onto it. This page covers the layout, updates, the migration and rollback.

Older installs ran the console as one `vardo-frontend` container, swapped by hand-written blue/green steps in `install.sh`:

```
cd /opt/vardo/apps/vardo/env/<standby> && git reset --hard origin/main \
  && docker compose -p vardo build frontend && docker compose -p vardo up -d frontend
```

## The layout

`docker-compose.yml` marks `postgres`, `redis`, `traefik`, `wireguard`, `buildkit` and `watchdog` with `x-vardo-shared: true`. Those stay in compose project `vardo`, on the volumes and networks they already have, and a deploy leaves them running. When a shared service's definition changes, the deploy recreates the stateless ones and holds `postgres` and `redis`, logging the command to apply it and finishing with a warning. Only `frontend` rotates, into `vardo-production-blue` and `vardo-production-green`.

The engine gives these services no tier limits or CPU weights; `docker-compose.yml` sets their memory. A difference in labels, CPU weights or how a limit is written doesn't count as a definition change (see [shared-services.md](shared-services.md)).

The engine honors `COMPOSE_PROFILES` from `/opt/vardo/.env`: `buildkit` runs only with `buildkit` in it.

Shared services in any app, and the commit-tag pattern for one that runs the app's own build, are covered in [shared-services.md](shared-services.md).

| | Legacy | Self-deploy |
| --- | --- | --- |
| Infra project | `vardo` | `vardo`, unchanged |
| Console project | `vardo` | `vardo-production-{blue,green}` |
| Slot dirs | `/opt/vardo/apps/vardo/env/{blue,green}` | `/opt/vardo/apps/vardo/production/{blue,green}` + `current` |
| Infra volumes and networks | `vardo_*` | unchanged |
| Infra container names | `vardo-postgres`, … | unchanged |
| Updated by | the legacy swap in `install.sh` | a deploy of the `vardo` app |

The shared project is pinned by the compose file's top-level `name: vardo`, so **no volume, network or container is renamed and no data is copied**.

`/opt/vardo/.env` stays the instance's settings file. Each deploy builds the slot `.env` from it, keeping only `GIT_SHA` and `COMPOSE_PROJECT_NAME` from the previous slot. To change a setting, edit `/opt/vardo/.env` and redeploy. `vardo key set` and `vardo setup-token` redeploy for you.

The `vardo` app record comes from `lib/docker/self-register.ts`, which runs on every boot once `production/current` exists, or when Self-management is on. Self-management defaults on in this layout.

## Updating

Any of these redeploys the `vardo` app:

- **Update now** under Admin → Settings → Maintenance → Updates, on the attention bar's Vardo update row, or from the link in the update email.
- **Redeploy** on the `vardo` app in the dashboard. The app lives in the Vardo system organization.
- `vardo update` on the host.
- `POST /api/v1/admin/maintenance/update` as an instance admin, which is what Update now calls.

Update now dumps the database to `/opt/vardo/lifecycle/backups/` first, keeping the newest three, and follows the policy's channel. After the cutover the new console checks its services for five minutes and rolls back to the previous deploy through the engine when three checks in a row fail.

### Update policy

Set under Updates, per instance:

| Policy | What happens |
| --- | --- |
| Off | No update notices. Update now still works. |
| Notify | Admins get one email a day while an update is out. The default for new installs. |
| Auto | Vardo updates itself inside the maintenance window. |

The channel is every commit on `main` or GitHub releases only. Auto follows releases unless a channel is set. The maintenance window is a start and end time in the instance's time zone, or its own when one is set; an end before the start runs past midnight.

Before an automatic update starts, it checks that no deploy, backup, restore or restore drill is running, the disk has 5 GB free and is under 90% full, the core services are healthy and the target hasn't already failed here. Then it dumps the database. When any of that fails it skips the update and emails the reasons once a day per target; it tries again in the next window.

### Linked instances

On a mesh, mark one instance **Canary** and the others **Follows a canary**. Each heartbeat carries the instance's commit, since when it has run it and whether it's healthy. A follower on Auto takes a version once the canary has run that commit healthy for the configured hours, or once an admin approves it under Updates. Peers on a version without this report never satisfy the wait, so approval is the way through until they update.

The running console builds the new one, starts it beside itself, waits for it to pass its health check, records the deploy and stops itself last. Both serve during the cutover.

### How `vardo update` reaches the console

`install.sh` writes `/opt/vardo/lifecycle/deploy-request.json`. Every console polls that directory, claims the request by renaming it and answers in `deploy-request.result.json` with the deployment id. `install.sh` then follows the deployment row in Postgres until it ends and checks:

- `production/current` points at the slot that's running and answering `/api/health`
- one slot console is running
- Redis `deploy:system:active` is back to 0
- the deployment row says `success`

Nothing listens on the network for this. Only root and the console's own user can write the lifecycle directory. A console writes `deploy-requests.ready` every few seconds; when it's missing or stale, `vardo update` stops and says why.

`vardo update` never runs the legacy swap on a self-deploy instance, and leaves `.env` alone apart from install-time options given with it (`--set`, `--trusted-proxies` and the rest).

### Notifications

A deploy of the `vardo` app writes `/opt/vardo/lifecycle/update.json` the way the legacy update does, with `kind: "self-deploy"`. The same events go out:

- **Vardo updating**, from the running console once the new image is built
- **Vardo updated**, from the new console once the old one recorded success. "Console down" is 0s when both slots served through the cutover.
- **Vardo update failed**, from the console that keeps serving, with the stage, error and log tail. "Rolled back" means the new slot was removed and the old one never stopped.

The new console starts while the old one is still running. It finds the update in flight and waits for its result, so it isn't reported as a restart. The old console sends no shutdown email for the stop that ends its own deploy.

A self-deploy runs on the old slot's code. A change to the deploy path, or to these markers, takes effect from the second deploy after it ships.

## Migrating a legacy install

```
sudo vardo migrate-self-deploy          # asks before it changes anything
sudo vardo migrate-self-deploy --yes    # no prompt
```

`vardo update` on a legacy install offers the same migration; `--yes` accepts it. On a host whose `vardo` command predates the migration, run the current script:

```
curl -fsSL https://vardo.run/install.sh | sudo bash -s migrate-self-deploy --yes
```

What it does, in order:

1. **Backup.** `pg_dump` to `/opt/vardo/backups/pre-self-deploy-<time>.sql`. It stops here if the dump fails.
2. **Console.** If the running console predates deploy requests, it updates it the legacy way first, then waits for it to listen.
3. **Deploy.** It asks the console to deploy the `vardo` app. The engine finds no active slot under `production/`, so it builds into `vardo-production-blue` and starts it beside `vardo-frontend`, which it doesn't know about and doesn't stop. Shared services report `Running`, not `Recreated`. In the deploy log, `postgres`, `traefik` and `wireguard` read `unchanged (only labels, CPU weights or how limits are written differ)`. `redis` and `watchdog` mount scripts from the repo instead of `env/current`, so `watchdog` is recreated and `redis` is held.
4. **Checks.** The four checks under [Updating](#updating), plus the new console's health.
5. **Retire.** Only once the new console is healthy: `docker stop vardo-frontend`, `docker rm vardo-frontend`, and removal of the empty `vardo-production-<slot>_*` copies of volumes only the shared services mount. Docker refuses to remove any volume still in use. Nothing named `vardo_*` is touched.
6. **Held data stores.** A `postgres` or `redis` the deploy held is recreated on its new definition when its image is unchanged. That restarts it for a few seconds; only the console uses them. With a new image, it prints the command instead. `vardo update` does the same after every redeploy.

Running it again is safe. On an instance that already deploys itself it only retires a `vardo-frontend` that's still running, once the slot console is healthy.

`/opt/vardo/apps/vardo/env` is no longer used afterward. Keep it until a redeploy has succeeded; it's what rollback starts from.

### Fresh installs

`install.sh` brings the first console up as `vardo-frontend` from `apps/vardo/env/blue`, then runs steps 3 to 5. A host without a deploy request answer within a few minutes stays on the legacy layout with a warning; `vardo migrate-self-deploy` finishes it. The image is built twice, the second time mostly from cache.

## Rollback

Nothing is renamed, copied or deleted, so rollback is starting the old console again. The shared services run throughout, so the database is never in question. The migration's backup is in `/opt/vardo/backups/`.

Run these in order, whether `vardo-frontend` is still running or was removed:

```
docker rm -f vardo-production-<slot>-frontend-1
rm -f "$(docker volume inspect -f '{{.Mountpoint}}' vardo_traefik_dynamic)/cutover-vardo-production.yml"
rm -f /opt/vardo/apps/vardo/production/current
cd /opt/vardo/apps/vardo/env/current
docker compose -p vardo up -d --no-deps frontend
```

The order matters:

- The slot console takes the address `vardo-frontend` pins on `vardo_mesh`. Starting `vardo-frontend` while it runs fails with "Address already in use".
- A self-deploy leaves `cutover-vardo-production.yml` in Traefik's dynamic config, pinning the console's domain to the slot container. Left behind, the console answers 502 after rollback.

Without `production/current`, `vardo update` takes the legacy path again.

## Risk

**Downtime is one console swap, not an outage.** Traefik and WireGuard keep running, so tenant apps are unaffected.

- **Redis restarts once, at step 6.** Its entrypoint script moves from `env/current` to the repo checkout. Only the console uses it, and it reconnects. Postgres keeps running unless its definition really changed.
- **The watchdog is recreated at migration and on every release.** It carries the release in its environment so it runs the new script. It routes no traffic.

- **The migration runs two consoles against one database for a minute.** Same commit, so the schema matches, and it's the overlap every app deploy has.
- **A failed deploy leaves a stopped container and an empty volume.** The next deploy's pre-clean removes the container; the retire step or `docker volume rm` covers the volume.
- **A stale `production/current` is the dangerous failure.** The engine trusts it to pick the active slot, so the next deploy would replace the console that's serving. `vardo update` checks it after every deploy.
