# Deployment Guide

Vardo deploys apps as Docker Compose stacks. Every deploy goes through the same pipeline: clone or build → start a new container slot → health check → route traffic → tear down the old slot. You get zero-downtime deploys by default.

## Deploy types

| Type | What it does |
|---|---|
| `compose` | Uses a `docker-compose.yml` from your repo or inline content |
| `dockerfile` | Builds from a `Dockerfile` in the repo |
| `image` | Pulls a pre-built image from a registry |
| `nixpacks` | Auto-detects the runtime and builds with [Nixpacks](https://nixpacks.com/) |
| `static` | Serves static files |

If `deployType` is `compose` but no compose file is found, Vardo auto-detects: it checks for a `Dockerfile` first, then falls back to Nixpacks.

### Railpack buildpack support

> **Planned** — Tracked in [#322](https://github.com/joeyyax/vardo/issues/322)

Vardo will add support for [Railpacks](https://railpacks.com/) as an additional buildpack-based deploy type alongside Nixpacks. Railpacks offers faster builds for supported frameworks and first-class support for Ruby on Rails applications.

When implemented, `railpack` will appear as a deploy type option alongside `nixpacks`. Vardo will run the Railpack CLI in the same way it currently invokes the Nixpacks CLI — auto-detecting the framework from the repository and producing a Docker image without requiring a Dockerfile.

## Source types

**Git repo** — Vardo clones or pulls the repo at deploy time. Supports any git URL. For GitHub, it authenticates via GitHub App token when available, or falls back to an SSH deploy key.

```
https://github.com/owner/repo.git   # public or GitHub App auth
git@github.com:owner/repo.git       # SSH key auth
```

**Docker image** — Pulls an image directly (e.g. `postgres:16`, `ghcr.io/owner/app:latest`). No build step.

**Inline compose** — Paste a compose file directly in the UI. Vardo stores it in the database and uses it at deploy time.

## Blue-green deployment

Every deploy uses blue-green slots. The directory layout looks like this:

```
.host/projects/{appName}/{envName}/
  blue/
    docker-compose.yml
    .env
  green/
    docker-compose.yml
    .env
  .active-slot      # "blue" or "green"
```

The deploy process:

1. Identify the active slot (read `.active-slot`). New deploys target the *other* slot.
2. Write the compose file and `.env` to the new slot directory.
3. Start the new slot with `docker compose up -d`.
4. Wait for the new slot to be healthy (container health checks, up to 60 seconds).
5. If unhealthy: tear down the new slot, throw an error — the active slot keeps serving traffic.
6. If healthy: Traefik discovers the new containers via labels on the shared Docker network and starts routing traffic.
7. Tear down the old slot.
8. Write the new slot name to `.active-slot`.

Traefik routes traffic by matching container labels. Because both slots run on the same `vardo-network`, Traefik can discover them automatically without a reload.

## Deployment lifecycle

```
queued → running → success
                 → failed
                 → cancelled
                 → rolled_back
```

| Status | Meaning |
|---|---|
| `queued` | Deployment record created, not yet started |
| `running` | Deploy in progress |
| `success` | Deployed and healthy |
| `failed` | Build, start, or health check failed |
| `cancelled` | Aborted before completion |
| `rolled_back` | Auto-rollback triggered after post-deploy crash |

## Deploy stages

The deploy pipeline emits stage events in real time over Redis pub/sub (consumed by the live log UI):

| Stage | Description |
|---|---|
| `clone` | Clone or pull git repo. Skipped for image deploys. |
| `build` | Build image (Dockerfile/Nixpacks) or parse compose file |
| `deploy` | Start the new slot |
| `healthcheck` | Wait for containers to become healthy |
| `routing` | Confirm Traefik has picked up the new containers |
| `cleanup` | Tear down the old slot |
| `done` | Deploy complete |

## Health checks

After starting the new slot, Vardo polls the containers for up to 60 seconds (default, 2-second interval). A container is considered healthy when:

- All containers in the compose project are in `running` state (not `exited`, `dead`, or `restarting`)
- Docker's built-in health check passes (if defined in the compose file)

If the health check times out, Vardo:
1. Fetches the last 30 lines of container logs
2. Tears down the new slot
3. Marks the deployment as `failed`
4. Leaves the previous slot running (no traffic interruption)

## Auto-rollback

Enable auto-rollback per app (`autoRollback: true`). After a successful deploy, a background monitor watches the new containers for crashes during a configurable grace period (`rollbackGracePeriod`, default 60 seconds).

If a crash is detected within the grace period:
1. Tear down the crashed slot
2. Bring back the previous slot
3. Update the `.active-slot` marker
4. Mark the deployment as `rolled_back`
5. Send a notification

The monitor polls every 5 seconds. It will not trigger on transient Docker socket errors — only on confirmed container exits or crash-restart loops.

## Manual rollback

To roll back manually, trigger a new deploy from any previous successful deployment snapshot. The deploy API accepts a `rollbackFromId` parameter. Rollbacks use the saved `configSnapshot` and `envSnapshot` from the target deployment.

## Deployment triggers

| Trigger | Description |
|---|---|
| `manual` | Triggered by a user via the UI or API |
| `webhook` | Triggered by a GitHub push webhook |
| `api` | Triggered via the REST API |
| `rollback` | Triggered by a rollback operation |

## GitHub integration

### Webhooks

Vardo receives GitHub webhooks to trigger auto-deploys on push. Install the GitHub App to your account or organization, then connect repos in the app settings.

When a push event arrives, Vardo matches it against apps by repo URL and branch. If `autoDeploy` is enabled on the app, a deployment is queued.

### Auto-deploy on push

Set `autoDeploy: true` on an app to deploy automatically when its branch receives a push. The deployment trigger is `webhook`.

### Private repos

For GitHub repos, Vardo uses a GitHub App installation token automatically. For non-GitHub repos or as a fallback, you can attach an SSH deploy key to the app. Vardo encrypts private keys at rest (AES-256-GCM).

## Preview environments from PRs

When a PR is opened against a branch Vardo is watching:

1. Vardo creates a group environment named `pr-{prNumber}`.
2. The entire project is cloned into the new environment (all apps in the project).
3. Each app gets a preview subdomain: `{appName}-pr-{prNumber}.{baseDomain}`.
4. The PR branch is deployed.

When the PR is closed or merged:
- The preview environment and all its containers are destroyed.
- Preview environments expire after 7 days (configurable) and are cleaned up by a cron job.

Preview environments only work for apps that belong to a project (group of apps). Standalone apps can't get previews.

## Deploy keys (SSH)

Deploy keys are RSA key pairs stored per-organization. Vardo generates the key pair, stores the private key encrypted (AES-256-GCM), and gives you the public key to add to your git host.

To use a deploy key:
1. Create a deploy key in **Settings → Deploy Keys**.
2. Add the public key to your GitHub/GitLab repo's deploy keys.
3. Attach the key to your app in the app's source settings.

If the app has a deploy key and no GitHub App token is available, Vardo writes the private key to a temporary file, sets `GIT_SSH_COMMAND`, runs the git operation, then immediately deletes the temp file.

## Environment variables

Env vars are stored encrypted (AES-256-GCM) in the database and decrypted at deploy time. They are written to a `.env` file in the slot directory and loaded via `env_file` in the compose file (not inlined in the compose `environment:` block — Docker Compose would try to interpret `${}` expressions before Vardo can resolve them).

### Variable resolution syntax

Values can contain `${...}` expressions resolved at deploy time:

| Expression | Resolves to |
|---|---|
| `${OTHER_VAR}` | Another env var in the same app |
| `${project.name}` | The app's internal name |
| `${project.domain}` | The app's primary domain |
| `${project.url}` | `https://{domain}` |
| `${project.port}` | The container port |
| `${project.internalHost}` | Docker network hostname (same as `project.name`) |
| `${project.gitBranch}` | The configured git branch |
| `${org.name}` | The organization name |
| `${org.baseDomain}` | The org's base domain |
| `${org.MY_VAR}` | An org-level shared env var |
| `${postgres.DATABASE_URL}` | `DATABASE_URL` from the `postgres` app in the same org |

Cross-app references (`${appName.VAR_KEY}`) are resolved by decrypting the referenced app's env vars at deploy time.

### Org-level env vars

Org-level env vars are shared across all apps in the organization. Reference them with `${org.KEY}`. Mark them as secrets to store them encrypted.

## Resource limits

Set CPU and memory limits per app:

- `cpuLimit`: CPU cores (e.g. `0.5`, `1`, `2`). Maps to the Docker Compose `deploy.resources.limits.cpus` field.
- `memoryLimit`: Memory in MB (e.g. `256`, `512`, `1024`). Maps to `deploy.resources.limits.memory`.

Vardo injects these into the compose file before deploy. If either limit is set, it applies to all services in the compose file.

If a volume exceeds its configured `maxSizeBytes` limit, the deploy is blocked with an error. A warning is emitted when usage exceeds `warnAtPercent` (default 80%).

## Persistent storage

Named Docker volumes survive deploys. Vardo tracks volumes in the `volume` table and mounts them across blue-green slots.

Volume naming convention: `{appName}-{slot}_{volumeName}` — e.g. `myapp-blue_data`. When backing up, Vardo checks the blue volume first, then the green volume.

Volumes are auto-detected:
- **From compose files**: Named volumes declared in the compose `volumes:` section are registered in the database.
- **From running containers**: After a successful deploy, Vardo inspects running containers and registers any mounted named volumes it hasn't seen before.
- **From `vardo.yml`**: If the repo has a `vardo.yml` config file, volumes declared there are registered before deploy.

Host bind mounts (paths starting with `/`, `./`, or `../`) are not allowed by default. The compose validator will reject them unless unsafe compose is explicitly enabled.

## Port exposure

For HTTP apps, Vardo routes traffic through Traefik — no host port bindings needed. For non-HTTP services (databases, etc.), you can declare exposed ports that map to host ports:

```json
[{ "internal": 5432, "external": 5432 }]
```

Container port detection priority:
1. `containerPort` set on the app
2. `EXPOSE` instruction in the image (inspected after build)
3. `PORT` env var
4. Default: 3000

## Traefik labels

Vardo injects Traefik labels automatically based on the app's domains. For each domain:

- HTTPS router on the `websecure` entrypoint with TLS
- HTTP→HTTPS redirect router on the `web` entrypoint
- Load balancer pointing at the container port
- Certificate resolver (`le` = Let's Encrypt by default)

For `.localhost` domains, TLS is configured without a cert resolver (Traefik generates a self-signed cert).

All services are attached to the `vardo-network` external Docker network so Traefik can discover them.

## Project group deploys

Apps in a project can declare dependencies on each other. When you deploy an entire project, Vardo:

1. Builds a dependency graph (from explicit `dependsOn` and inferred cross-app `${appName.VAR}` references).
2. Topologically sorts apps into tiers.
3. Deploys each tier in parallel. All apps in a tier deploy at the same time.
4. If any app in a tier fails, remaining tiers are aborted.

This ensures that database apps deploy before the web apps that depend on them.

## `vardo.yml` config file (per-repo)

Drop a `vardo.yml` in your repo root to configure deployment behavior as code. This takes priority over equivalent settings stored in the database.

```yaml
project:
  rootDirectory: backend

runtime:
  port: 8080

volumes:
  - name: data
    mountPath: /app/data

env:
  - key: NODE_ENV
    value: production
```

Settings in `vardo.yml` take effect at deploy time. Env vars from the file only apply if the key isn't already set in the app's env vars (they don't override).

See [Configuration](configuration.md) for the full `vardo.yml` reference.
