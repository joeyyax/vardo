# API Reference

## Authentication

All API endpoints (except `/api/health` and `/api/v1/github/webhook`) require authentication. Vardo supports two authentication methods:

### Session Cookies

The web dashboard uses session-based authentication managed by Better Auth. Sessions are stored in PostgreSQL, expire after 7 days (configurable), and are refreshed every 24 hours. When using the API from a browser context, the session cookie is sent automatically.

### API Tokens

> **Planned** — Tracked in [#172](https://github.com/joeyyax/vardo/issues/172)

API token authentication is partially implemented. Token creation and management endpoints are available (`/api/v1/organizations/{orgId}/tokens`), and tokens are stored as SHA-256 hashes with a `vardo_` prefix. However, token-based request authentication is not yet wired into the middleware — tokens cannot be used to authenticate API requests yet.

When fully implemented, you will be able to create a long-lived API token from **Settings → API Tokens** and use it as a Bearer token:

```bash
curl -s https://vardo.example.com/api/v1/organizations \
  -H "Authorization: Bearer vardo_<your-token>"
```

Tokens will be scoped to a specific organization and user, and displayed only once at creation time.

### Programmatic Access (Current Workaround)

Until token auth is wired up, use session cookies. Sign in via the browser, copy the session cookie:

```bash
curl -s https://vardo.example.com/api/v1/organizations \
  -H "Cookie: better-auth.session_token=<your-session-token>"
```

## Base URL

All versioned API endpoints follow the pattern:

```
/api/v1/organizations/{orgId}/...
```

The `orgId` is the organization ID (not the slug). You can find it from the organization list endpoint or from the dashboard URL.

## Endpoints

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Basic health check (unauthenticated) |
| GET | `/api/v1/admin/health` | Detailed health with feature flag status (admin only) |

### Organizations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations` | List organizations for the current user |
| POST | `/api/v1/organizations` | Create a new organization |
| GET | `/api/v1/organizations/{orgId}` | Get organization details |
| GET | `/api/v1/organizations/{orgId}/members` | List organization members |
| PUT | `/api/v1/organizations/{orgId}/members/{userId}` | Update a member's role |
| DELETE | `/api/v1/organizations/{orgId}/members/{userId}` | Remove a member |
| POST | `/api/v1/organizations/switch` | Switch the active organization |

### Invitations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/invitations` | List pending invitations |
| POST | `/api/v1/organizations/{orgId}/invitations` | Invite a user to the org |
| DELETE | `/api/v1/organizations/{orgId}/invitations/{invitationId}` | Cancel an invitation |
| POST | `/api/v1/invitations/accept` | Accept an invitation (unauthenticated, token-verified) |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/projects` | List all projects |
| POST | `/api/v1/organizations/{orgId}/projects` | Create a project |
| GET | `/api/v1/organizations/{orgId}/projects/{projectId}` | Get project details |
| PATCH | `/api/v1/organizations/{orgId}/projects/{projectId}` | Update a project |
| DELETE | `/api/v1/organizations/{orgId}/projects/{projectId}` | Delete a project |

### Apps

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/apps` | List all apps |
| POST | `/api/v1/organizations/{orgId}/apps` | Create an app |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}` | Get app details |
| PATCH | `/api/v1/organizations/{orgId}/apps/{appId}` | Update an app |
| DELETE | `/api/v1/organizations/{orgId}/apps/{appId}` | Delete an app |
| PUT | `/api/v1/organizations/{orgId}/apps/sort` | Update app sort order |

### Deployments

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/deploy` | Trigger a deployment (returns SSE stream) |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/deploy/stream` | Stream deployment logs (SSE) |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/stop` | Stop an app |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/restart` | Restart an app |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/rollback` | Roll back to a previous deployment |

The deploy endpoint accepts an optional JSON body:

```json
{
  "environmentId": "env_abc123",
  "groupEnvironmentId": "genv_abc123",
  "deployAll": true
}
```

- Omit the body or send `{}` to deploy to the default (production) environment.
- Set `deployAll: true` to trigger a group deploy of all apps in the project.
- The response is a Server-Sent Events (SSE) stream with `log`, `stage`, `tier`, and `done` events.

### Git Branches

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/branches` | List branches for the app's connected repository |

### Environment Variables

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/env-vars` | List app env vars |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/env-vars` | Set env vars |
| GET | `/api/v1/organizations/{orgId}/env-vars` | List org-level shared env vars |
| POST | `/api/v1/organizations/{orgId}/env-vars` | Set org-level shared env vars |

### Domains

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/domains` | List app domains |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/domains` | Add a domain |
| PUT | `/api/v1/organizations/{orgId}/apps/{appId}/domains/primary` | Set the primary domain |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/domains/health` | Check domain health |
| GET | `/api/v1/organizations/{orgId}/domains` | List all org domains |
| GET | `/api/v1/dns-check` | Check DNS resolution for a domain |

### Environments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/environments` | List app environments |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/environments` | Create an environment |
| PATCH | `/api/v1/organizations/{orgId}/apps/{appId}/environments/{envId}` | Update an environment |
| DELETE | `/api/v1/organizations/{orgId}/apps/{appId}/environments/{envId}` | Delete an environment |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/environments/{envId}/clone` | Clone an environment |
| POST | `/api/v1/organizations/{orgId}/projects/{projectId}/environments` | Create a group environment |

### Monitoring

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/stats` | Current container stats (CPU, memory, network) |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/stats/stream` | Live stats stream (SSE) |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/stats/history` | Historical stats |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/logs` | Query logs from Loki |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/logs/stream` | Live log stream (SSE) |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/containers` | List containers for an app |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/events` | Docker events for an app |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/volumes` | List volumes |
| PUT | `/api/v1/organizations/{orgId}/apps/{appId}/volumes/limits` | Set volume size limits |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/terminal` | WebSocket terminal access |

### Project-Level Stats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/projects/{projectId}/stats` | Aggregate stats for a project |
| GET | `/api/v1/organizations/{orgId}/projects/{projectId}/stats/stream` | Live project stats (SSE) |
| GET | `/api/v1/organizations/{orgId}/projects/{projectId}/stats/history` | Historical project stats |
| GET | `/api/v1/organizations/{orgId}/stats` | Aggregate stats for entire org |
| GET | `/api/v1/organizations/{orgId}/stats/stream` | Live org stats (SSE) |
| GET | `/api/v1/organizations/{orgId}/stats/business` | Business metrics |

### Backups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/backups` | List backup jobs and history |
| GET | `/api/v1/organizations/{orgId}/backups/targets` | List backup targets |
| POST | `/api/v1/organizations/{orgId}/backups/targets` | Create a backup target |
| GET | `/api/v1/organizations/{orgId}/backups/jobs/{jobId}` | Get backup job details |
| PATCH | `/api/v1/organizations/{orgId}/backups/jobs/{jobId}` | Update a backup job |
| POST | `/api/v1/organizations/{orgId}/backups/jobs/{jobId}/run` | Trigger a backup job manually |
| GET | `/api/v1/organizations/{orgId}/backups/history/{backupId}/download` | Download a backup |
| POST | `/api/v1/organizations/{orgId}/backups/history/{backupId}/restore` | Restore from a backup |

### Cron Jobs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/cron` | List cron jobs for an app |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/cron` | Create a cron job |

### Tags

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/tags` | List tags |
| POST | `/api/v1/organizations/{orgId}/tags` | Create a tag |
| GET | `/api/v1/organizations/{orgId}/apps/{appId}/tags` | List tags for an app |
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/tags` | Add/remove tags on an app |

### Transfers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/organizations/{orgId}/apps/{appId}/transfer` | Initiate an app transfer |
| GET | `/api/v1/organizations/{orgId}/transfers` | List incoming/outgoing transfers |
| POST | `/api/v1/organizations/{orgId}/transfers/{transferId}` | Accept or reject a transfer |

### Deploy Keys

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/deploy-keys` | List deploy keys |
| POST | `/api/v1/organizations/{orgId}/deploy-keys` | Create a deploy key |
| DELETE | `/api/v1/organizations/{orgId}/deploy-keys/{keyId}` | Delete a deploy key |

### API Tokens

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/tokens` | List API tokens |
| POST | `/api/v1/organizations/{orgId}/tokens` | Create a new token |
| DELETE | `/api/v1/organizations/{orgId}/tokens` | Delete a token |

### Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/notifications` | List notification channels |
| POST | `/api/v1/organizations/{orgId}/notifications` | Create a notification channel |
| PATCH | `/api/v1/organizations/{orgId}/notifications/{channelId}` | Update a channel |
| DELETE | `/api/v1/organizations/{orgId}/notifications/{channelId}` | Delete a channel |

### Digest

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/digest` | Get digest settings |
| PATCH | `/api/v1/organizations/{orgId}/digest` | Update digest settings |

### Activity Log

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/activities` | List activity entries |

### Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/organizations/{orgId}/search` | Search apps, projects, and more |

### GitHub Integration

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/github/installations` | List connected GitHub installations |
| GET | `/api/v1/github/repos` | List repositories from connected installations |
| GET | `/api/v1/github/branches` | List branches for a repository |
| GET | `/api/v1/github/connect` | Get GitHub App install URL |
| GET | `/api/v1/github/callback` | OAuth callback handler |
| GET | `/api/v1/github/env-scan` | Scan a repo for environment variable usage |
| POST | `/api/v1/github/webhook` | GitHub webhook receiver (unauthenticated, signature-verified) |

### Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/templates` | List available templates |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/health` | System health with feature flags |
| GET | `/api/v1/admin/stats` | Admin-level system stats |
| GET | `/api/v1/admin/stats/stream` | Admin stats stream (SSE) |
| GET | `/api/v1/admin/overview` | System overview |
| GET | `/api/v1/admin/organizations` | List all organizations |
| GET | `/api/v1/admin/users` | List all users |
| GET | `/api/v1/admin/backup-targets` | List all backup targets |
| GET | `/api/v1/admin/backups` | List all backups (system-wide) |
| POST | `/api/v1/admin/docker-prune` | Prune unused Docker resources |
| GET | `/api/v1/admin/dns-check` | DNS check (admin context) |
| GET | `/api/v1/admin/config/export` | Export current config as vardo.yml + vardo.secrets.yml |
| POST | `/api/v1/admin/config/import` | Import a vardo.yml config into system settings |

### Mesh (Multi-Instance)

These endpoints are only available when the `mesh` feature flag is enabled.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/mesh/peers` | List connected mesh peers |
| POST | `/api/v1/admin/mesh/join` | Join a mesh network (connect to a peer) |
| POST | `/api/v1/admin/mesh/invite` | Generate an invite token for a new peer |
| POST | `/api/v1/admin/mesh/clone` | Clone an app from another instance |
| POST | `/api/v1/admin/mesh/promote` | Promote an app to another instance |
| POST | `/api/v1/admin/mesh/pull` | Pull an app's config/volumes from another instance |
| POST | `/api/v1/mesh/heartbeat` | Internal peer heartbeat (peer-to-peer) |
| POST | `/api/v1/mesh/sync` | Sync state with a peer |
| POST | `/api/v1/mesh/clone` | Receive a cloned app from another instance |
| POST | `/api/v1/mesh/promote` | Receive a promoted app from another instance |
| POST | `/api/v1/mesh/pull` | Respond to a pull request from another instance |
| POST | `/api/v1/mesh/join` | Accept a join request from another instance |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/system/alerts` | List system alerts |

## Rate Limits

Rate limiting is applied per IP address using an in-memory store.

| Endpoint Group | Limit | Window |
|---------------|-------|--------|
| Deploy | 10 requests | 60 seconds |
| Webhook | 30 requests | 60 seconds |

When rate-limited, the API returns HTTP 429 with a `Retry-After` header indicating the number of seconds to wait.

## Webhook Format

Vardo receives GitHub webhooks at `/api/v1/github/webhook`. The webhook secret is verified using HMAC-SHA256 (`x-hub-signature-256` header).

### Supported Events

**`push`** — Triggers auto-deploy for apps that match the repository URL and branch with `autoDeploy` enabled.

Response:
```json
{
  "ok": true,
  "deployments": [
    { "app": "my-app", "deploymentId": "abc123", "success": true }
  ]
}
```

**`pull_request`** — Creates or destroys preview environments.

- `opened`, `reopened`, `synchronize` — Creates a preview group environment for the matching project, deploys all apps, and posts preview URLs as a PR comment.
- `closed` — Destroys the preview environment and tears down all containers.

Response:
```json
{
  "ok": true,
  "preview": {
    "groupEnvironmentId": "genv_abc123",
    "domains": [
      { "appName": "web", "domain": "pr-42-web.example.com" }
    ],
    "deployed": true
  }
}
```

All other event types are acknowledged with `{"ok": true, "skipped": "<event-type>"}`.

## Error Format

All error responses follow a consistent format:

```json
{
  "error": "Human-readable error message"
}
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| 400 | Bad request (validation error) |
| 401 | Unauthorized (not authenticated) |
| 403 | Forbidden (no access to this organization) |
| 404 | Not found |
| 409 | Conflict (e.g. duplicate name) |
| 429 | Too many requests (rate limited) |
| 500 | Internal server error |
