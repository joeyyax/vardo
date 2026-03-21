# Concepts

## Organizations

Organizations are the top-level tenant boundary. All resources -- projects, apps, environment variables, API tokens, backup targets -- are scoped to an organization. Users can belong to multiple organizations with role-based access (owner, admin, member).

Organizations can have:
- A **base domain** for auto-generated app subdomains.
- **Shared environment variables** available to all apps in the organization via `${org.VAR_NAME}` references.
- **Custom domains** registered at the org level.
- **Notification channels** (email, webhook, Slack) for alerts on deploys and backups.

## Projects

Projects group related apps together. A "WordPress" project might contain a WordPress app and a MySQL database. A "SaaS" project might include a web frontend, an API server, and a Redis cache.

Projects enable:
- **Group deploys** -- deploy all apps in a project in the correct order, respecting dependencies.
- **Group environments** -- create a staging or preview environment spanning all apps in a project.
- **Visual organization** -- each project has a name, description, and color.

Projects are optional. Apps can exist without a project.

## Apps

Apps are the core deployable unit. Each app represents a Docker service (or set of services, in the case of Compose) that Host manages through its lifecycle: build, deploy, start, stop, restart, and teardown.

### Source Types

| Source | Description |
|--------|-------------|
| **git** | Cloned from a Git repository (GitHub, Gitea, any HTTPS URL) |
| **direct** | Configured directly -- image name, compose content, or Dockerfile |

### Deploy Types

| Type | Description |
|------|-------------|
| **compose** | Deploys a `docker-compose.yml` file. The most flexible option. |
| **dockerfile** | Builds from a Dockerfile in the repository. |
| **image** | Pulls and runs a Docker image directly (e.g. `postgres:16`). |
| **nixpacks** | Auto-detects the language and generates a build configuration. |
| **static** | Serves static files. |

### App Lifecycle

Apps track their status as one of: **active**, **stopped**, **error**, or **deploying**. Each app has a deployment history with individual deployment records that track status (queued, running, success, failed, cancelled), trigger source, git SHA, duration, and logs.

### Additional App Features

- **Tags** -- flat labels for filtering and organizing apps.
- **Cron jobs** -- scheduled command execution or URL pinging inside containers.
- **Volume limits** -- per-app storage constraints with configurable warning thresholds.
- **Exposed ports** -- direct TCP/UDP port exposure with automatic allocation.
- **Connection info** -- structured metadata showing how to connect to the service (e.g. database URLs, credentials).
- **Transfers** -- move an app between organizations with frozen environment variable references.

## Environments

Each app has one or more environments. A **production** environment is created automatically when an app is created and is marked as the default.

Environment types:
- **production** -- the live environment.
- **staging** -- a pre-production environment for testing.
- **preview** -- ephemeral environments, typically created from pull requests.

Each environment can have its own:
- Environment variables (overriding production defaults)
- Git branch
- Domain
- Deployment history

### Group Environments

Group environments span an entire project, creating a corresponding per-app environment for every app in the project. This is useful for staging or preview environments where you need the entire stack -- database, API, frontend -- running as a coordinated unit.

When a GitHub pull request is opened against a project with auto-deploy enabled, Host can automatically create a preview group environment, deploy all apps, and post the preview URLs as a PR comment. Closing the PR destroys the preview.

## Variable Resolution

Host includes a template expression engine that resolves `${...}` references at deploy time. This enables dynamic configuration without hardcoding values.

### Expression Types

| Syntax | Description | Example |
|--------|-------------|---------|
| `${VAR}` | Reference another variable in the same app | `${DATABASE_URL}` |
| `${project.field}` | Built-in app fields | `${project.name}`, `${project.domain}` |
| `${org.field}` | Built-in org fields | `${org.baseDomain}` |
| `${org.VAR}` | Org-level shared variable | `${org.SHARED_SECRET}` |
| `${appName.VAR}` | Variable from another app in the same org | `${postgres.POSTGRES_PASSWORD}` |
| `${appName.field}` | Built-in field from another app | `${postgres.internalHost}` |

### Built-in Project Fields

| Field | Description |
|-------|-------------|
| `name` | URL-safe app name |
| `displayName` | Human-readable app name |
| `port` | Container port |
| `id` | App ID |
| `domain` | Primary domain |
| `url` | Full HTTPS URL (`https://domain`) |
| `host` | Same as `domain` |
| `internalHost` | Docker network hostname (same as `name`) |
| `gitUrl` | Git repository URL |
| `gitBranch` | Git branch |
| `imageName` | Docker image name |

### Built-in Org Fields

| Field | Description |
|-------|-------------|
| `name` | Organization name |
| `id` | Organization ID |
| `baseDomain` | Organization base domain |

### Resolution Order

Variables are resolved using topological sorting (Kahn's algorithm) to handle self-references correctly. Circular references are detected and produce an error. Cross-app references resolve by looking up the referenced app's encrypted environment variables.

## Templates

Templates are pre-configured service definitions stored as TOML files in the `templates/` directory. Each template defines defaults for a common service -- image name, environment variables, volumes, ports, and connection info.

Built-in templates include: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Nginx, Ghost, Adminer, MinIO, n8n, Uptime Kuma, and Gitea.

Templates use the variable resolution engine for connection info. For example, a PostgreSQL template's connection URL is:

```
postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${project.name}:5432/${POSTGRES_DB}
```

See [Configuration](configuration.md) for the full template TOML format.

## Blue-Green Deployments

Every deployment in Host uses a blue-green strategy to minimize downtime:

1. **Determine slot** -- Host reads the `.active-slot` file to find the current active slot (blue or green). The new deployment targets the opposite slot.
2. **Prepare** -- The compose file and resolved `.env` file are written to the new slot's directory.
3. **Start new slot** -- `docker compose up` starts the new containers. Traefik labels are applied so Traefik discovers the service on the Docker network.
4. **Health check** -- Host waits for the new containers to become healthy. If the health check fails, the new slot is torn down and the deployment is marked as failed. Container logs from the failed slot are captured for debugging.
5. **Route traffic** -- Traefik automatically routes traffic to the new containers once they are healthy and connected to the `host-network` Docker network.
6. **Tear down old slot** -- The previous slot's containers are stopped and removed.
7. **Record active slot** -- The `.active-slot` file is updated to reflect the new active slot.
8. **Domain health checks** -- HTTP health checks run against all configured domains to verify external reachability.
9. **Volume detection** -- Persistent volumes are automatically detected from running containers and recorded on the app.

If a deployment fails at any point, the old slot remains running and continues serving traffic. The failed slot is cleaned up automatically.

### Group Deploys

When deploying all apps in a project, Host builds a dependency graph from the `dependsOn` field and cross-app variable references. Apps are deployed in tiers -- independent apps deploy in parallel within the same tier, and each tier waits for the previous tier to complete before starting.
