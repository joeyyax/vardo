# Administration Guide

This guide covers the Vardo admin panel, system settings, and operational tasks for instance administrators.

An **app admin** is a user with `isAppAdmin=true` in the database. The first user to sign up is automatically promoted to app admin. Admins access the admin panel at `/admin`.

## Admin Panel Overview

The admin panel (`/admin`) provides six tabs:

| Tab | Description |
|-----|-------------|
| **Overview** | Instance health, resource usage, key counters |
| **System** | Docker info, service status, system details |
| **Organizations** | List and manage all organizations |
| **Users** | List and manage all users |
| **Maintenance** | Docker prune operations |
| **Metrics** | Business and infrastructure metrics across all orgs |

A **System settings** button in the toolbar links to the settings section (`/admin/settings`).

## System Settings

System settings are stored in the `system_settings` database table (key-value, values encrypted at rest). Settings can also be provided via `vardo.yml` / `vardo.secrets.yml` — the config file always takes priority over the database.

Navigate to **Admin → System settings** to access the following tabs.

### Overview

Shows a summary of all configured settings — email provider, GitHub App status, backup target count, feature flag states, and the active domain. Useful for verifying configuration at a glance.

### General

Instance-level settings:

| Setting | Description |
|---------|-------------|
| Instance name | Display name shown in the UI header |
| Domain | The public domain for this Vardo instance (used for redirect URLs and TLS) |
| Base domain | If set, apps can receive subdomains automatically (e.g. `myapp.yourdomain.com`) |

### Email

Email is required for magic link sign-in and notification delivery. Three providers are supported:

#### Mailpace

```yaml
# vardo.yml
email:
  provider: mailpace
  fromEmail: vardo@yourdomain.com
  fromName: Vardo

# vardo.secrets.yml
email:
  apiKey: "<mailpace api key>"
```

#### Resend

```yaml
# vardo.yml
email:
  provider: resend
  fromEmail: vardo@yourdomain.com
  fromName: Vardo

# vardo.secrets.yml
email:
  apiKey: "<resend api key>"
```

#### SMTP

```yaml
# vardo.yml
email:
  provider: smtp
  fromEmail: vardo@yourdomain.com
  fromName: Vardo
  smtpHost: smtp.yourprovider.com
  smtpPort: 587
  smtpUser: vardo@yourdomain.com

# vardo.secrets.yml
email:
  smtpPass: "<smtp password>"
```

After configuring, use the **Send test email** button in the admin UI to verify delivery.

**Environment variable fallback** — if no database config is set, Vardo reads:
- `RESEND_API_KEY` → Resend provider
- `MAILPACE_API_TOKEN` → Mailpace provider
- `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` → SMTP provider

> **Note on provider support** — Tracked in [#325](https://github.com/joeyyax/vardo/issues/325)
>
> Mailpace is the only provider fully wired end-to-end (transactional email, magic links, and notifications). Resend and SMTP are recognized as provider options in the config schema, but their sending paths are not yet fully connected. Use Mailpace for production deployments until #325 ships.

### Email delivery webhooks

> **Planned** — Tracked in [#306](https://github.com/joeyyax/vardo/issues/306)

Vardo will support inbound email delivery event webhooks from providers that support them (Mailpace, Resend). When configured, the provider sends bounce, complaint, and delivery status events to Vardo, which will:

- Surface per-notification delivery status in the admin UI
- Suppress future sends to addresses with hard bounces
- Alert the admin when a notification channel's delivery rate drops

This closes the feedback loop on whether notifications actually reached their destination.

### Authentication

Controls sign-in options and registration behavior:

| Setting | Description |
|---------|-------------|
| Registration mode | `open` — anyone can sign up; `closed` — invitations only; `approval` — sign-ups require admin approval |
| Session duration | How long sessions remain valid (default: 7 days) |

GitHub OAuth (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`) enables the **Sign in with GitHub** button. This is separate from the GitHub App integration used for deployments.

The `passwordAuth` feature flag controls whether email/password sign-in is available. Disable it to force passkey or OAuth-only authentication.

### Feature Flags

Feature flags control which sections of the UI and API are active. They are resolved in priority order:

1. `vardo.yml` `features:` block
2. `system_settings` table (`feature_flags` key)
3. Default: **enabled**

Core features (projects, apps, deployments) cannot be disabled.

| Flag | UI Key | Default | Controls |
|------|--------|---------|---------|
| `ui` | `FEATURE_UI` | on | Web dashboard. Disabling makes Vardo API-only. |
| `terminal` | `FEATURE_TERMINAL` | on | Web terminal tab on app detail pages |
| `environments` | `FEATURE_ENVIRONMENTS` | on | Multiple environments per app (staging, preview) |
| `backups` | `FEATURE_BACKUPS` | on | Scheduled volume backups to S3-compatible storage |
| `cron` | `FEATURE_CRON` | on | Scheduled cron jobs inside containers |
| `passwordAuth` | `FEATURE_PASSWORD_AUTH` | on | Email/password sign-in and onboarding |
| `mesh` | `FEATURE_MESH` | off | Multi-instance WireGuard mesh; adds Instances settings tab |

Toggling a flag from the admin UI writes to `system_settings` and takes effect on the next request. No restart required.

To set flags in config:

```yaml
# vardo.yml
features:
  terminal: false
  environments: false
  cron: false
```

### GitHub App

The GitHub App integration enables automatic deployments on push and pull request previews.

#### Setup

1. Create a GitHub App in your GitHub account or organization settings.
2. Set the webhook URL to `https://your-domain.com/api/v1/github/webhook`.
3. Required permissions: `Contents: read`, `Pull requests: read`.
4. Subscribe to events: `Push`, `Pull request`.
5. Generate a private key and download it.

#### Configuration

```yaml
# vardo.yml
github:
  appId: "123456"
  appSlug: "your-app-name"
  clientId: "Iv1.abc123"

# vardo.secrets.yml
github:
  clientSecret: "<client secret>"
  privateKey: "<base64-encoded PEM private key>"
  webhookSecret: "<random string used when creating the app>"
```

Or configure via the admin UI under **GitHub App** settings. The private key should be base64-encoded:

```bash
base64 -w 0 your-app.pem
```

#### How It Works

- **Push events** → Vardo finds all apps with `autoDeploy=true` matching the repo + branch, and triggers deployment.
- **Pull request events** → Vardo creates or destroys preview environments (requires `environments` feature flag).

### Backup Targets

System-level backup targets are S3-compatible storage locations available to all organizations. Individual org backups are configured per-org under **Settings → Backups**.

Supported target types: `s3`, `r2` (Cloudflare R2), `b2` (Backblaze B2), `ssh`.

Admin backup targets (`/api/v1/admin/backup-targets`) allow admins to pre-configure shared storage that orgs can select without managing their own credentials.

### Domain & SSL

| Setting | Description |
|---------|-------------|
| Domain | Primary domain for the Vardo instance |
| Base domain | Wildcard subdomain base for app routing (e.g. `apps.yourdomain.com`) |
| ACME email | Email for Let's Encrypt certificate registration |

SSL is handled by Traefik using Let's Encrypt TLS challenges. Traefik is configured via the `ACME_EMAIL` environment variable at startup; this cannot be changed without restarting Traefik.

### Config

Shows the effective configuration currently in use — merged from `vardo.yml`, database settings, and environment variables. Useful for debugging "which setting is actually active."

### Instances (mesh)

Only visible when the `mesh` feature flag is enabled. Allows connecting multiple Vardo instances over encrypted WireGuard tunnels. Connected instances can promote, pull, and clone apps between them.

## User and Organization Management

### Users

The **Users** tab shows all users in the system. Admins can:

- View user details (email, auth methods, creation date)
- Promote or revoke app admin status

### Organizations

The **Organizations** tab shows all organizations. Admins can:

- View org members and their roles
- Access any org's settings (for support/debugging)

## Vardo's Own Database Backup

Vardo's PostgreSQL data is in a Docker volume (`postgres_data`). For a production instance, set up automated backups of this volume.

### Option 1: pg_dump via cron

```bash
# Run from the host, daily at 2am
0 2 * * * docker exec vardo-postgres pg_dump -U vardo vardo | gzip > /backups/vardo-$(date +%Y%m%d).sql.gz
```

### Option 2: Volume snapshot

Most VPS providers (Hetzner, DigitalOcean, etc.) offer volume snapshots. Schedule daily snapshots of the disk containing Docker volumes.

### Restoring

```bash
# Stop the app first
docker compose stop vardo-frontend

# Restore
cat backup.sql.gz | gunzip | docker exec -i vardo-postgres psql -U vardo vardo

# Start the app
docker compose start vardo-frontend
```

## Instance Settings via vardo.yml

`vardo.yml` is the primary configuration file for instance settings. It lives at the root of the Vardo installation directory (typically `/opt/vardo/vardo.yml`).

```yaml
# vardo.yml — safe to commit, no secrets
instance:
  id: "my-vardo"
  name: "My Vardo"
  domain: "vardo.yourdomain.com"
  baseDomain: "apps.yourdomain.com"
  serverIp: "1.2.3.4"

auth:
  registrationMode: closed   # open | closed | approval
  sessionDurationDays: 7

features:
  terminal: true
  environments: true
  backups: true
  cron: true
  mesh: false
```

```yaml
# vardo.secrets.yml — never commit, chmod 600
encryptionKey: "<64-char hex>"
authSecret: "<random>"
acmeEmail: "you@yourdomain.com"
email:
  apiKey: "<provider api key>"
backup:
  accessKey: "<s3 key>"
  secretKey: "<s3 secret>"
github:
  clientSecret: "<secret>"
  privateKey: "<base64 pem>"
  webhookSecret: "<random>"
```

Config file values take precedence over all other configuration sources. Changes to `vardo.yml` take effect after restarting the app container.

## Updating Vardo

Vardo is updated by pulling the latest image and restarting:

```bash
cd /opt/vardo

# Pull latest images
docker compose pull

# Restart with new images (zero-downtime if using rolling restart)
docker compose up -d

# Run any pending database migrations
docker compose exec host pnpm db:migrate
```

The `install.sh update` mode automates this:

```bash
curl -fsSL https://get.vardo.sh | bash -s -- update
```

## System Health and Diagnostics

### Health Endpoint

```bash
curl https://your-domain.com/api/health
```

Returns CPU, memory, and disk usage with status (`ok`, `warning`, `critical`).

### Docker Diagnostics

From the admin panel **Maintenance** tab:

- **Docker prune** — removes unused images, stopped containers, and dangling networks. Use when disk is filling up.

From the host shell:

```bash
# Check all Vardo containers
docker ps --filter name=vardo

# View app logs
docker logs vardo-host --tail 100 -f

# Check resource usage
docker stats --no-stream
```

### install.sh Doctor Mode

```bash
curl -fsSL https://get.vardo.sh | bash -s -- doctor
```

Checks:
- Docker and Docker Compose versions
- Required ports (80, 443) are available
- Environment variables are set
- Services are healthy
- Disk space is adequate

## Traefik Configuration

Traefik runs as `vardo-traefik` and handles all inbound HTTP/HTTPS traffic. Configuration is set via Docker CLI flags in `docker-compose.yml`:

- HTTP (port 80) redirects permanently to HTTPS.
- HTTPS (port 443) uses Let's Encrypt TLS certificates via TLS challenge.
- Apps are routed by Traefik labels on their containers.
- Log level defaults to `WARN`. Set `TRAEFIK_LOG_LEVEL=DEBUG` for verbose output.

> Traefik's dashboard is not enabled by default. Avoid enabling it without authentication.

### Traefik admin UI

> **Planned** — Tracked in [#217](https://github.com/joeyyax/vardo/issues/217)

Vardo will expose Traefik's router, middleware, and service configuration through the admin UI, removing the need to inspect raw Traefik labels or enable the Traefik dashboard directly.

When implemented, admins will be able to see all active routers, their associated middleware chains, and which containers each service is load-balancing across — from within the Vardo dashboard, without needing shell access.

## Instance Portability

### Import / Export

> **Planned** — Tracked in [#198](https://github.com/joeyyax/vardo/issues/198)

Vardo will support exporting and importing instance state at four levels of depth:

1. **Settings only** — `vardo.yml` + `vardo.secrets.yml` (system configuration, no app data)
2. **Settings + env vars** — includes encrypted environment variables for all apps and orgs
3. **Settings + env vars + compose files** — includes the full deployment configuration for all apps
4. **Full export** — includes Docker volumes, enabling a complete migration to a new server

This covers both instance migration (moving to a larger server) and disaster recovery (restore from a full export after hardware failure). The export format will be a single encrypted archive with a manifest.

## Recommended Providers

> **Planned** — Tracked in [#327](https://github.com/joeyyax/vardo/issues/327)

A recommended providers guide is planned that will include referral and affiliate links for the hosting, storage, and email providers that work well with Vardo. In the meantime, the providers commonly used and tested with Vardo are:

**VPS / Servers:** Hetzner, DigitalOcean, Vultr
**Object storage (backups):** Cloudflare R2, Backblaze B2, AWS S3
**Email:** Mailpace, Resend
**DNS / CDN:** Cloudflare

## Troubleshooting Common Admin Tasks

### A user can't sign in

1. Check if `passwordAuth` is disabled — they may need to use a passkey or magic link.
2. Check if registration is `closed` — they may need an invitation.
3. Check the `session` table for expired or missing sessions.
4. Check email delivery if they're using magic link (test email from admin settings).

### Deployment not triggering on push

1. Verify the GitHub App webhook is configured correctly (URL, secret).
2. Check `/api/v1/github/webhook` is reachable from GitHub's servers.
3. Confirm the app has `autoDeploy=true` and the branch matches.
4. Check Vardo app logs: `docker logs vardo-host --tail 200 | grep webhook`.

### Disk space growing rapidly

1. Check the **Maintenance** tab → Docker prune to reclaim unused image layers.
2. Check which containers are writing heavily (disk write metrics in the UI).
3. Review backup storage — old backups may need cleanup.
4. `df -h /var/lib/docker` to confirm Docker volumes are the source.

### Feature flag change not taking effect

Feature flags are cached in memory for the process lifetime after initial load. If a flag was changed via the database (not `vardo.yml`), restart the app container:

```bash
docker compose restart host
```

If changed via `vardo.yml`, a restart is also required.

### Can't access the admin panel

Only users with `isAppAdmin=true` can access `/admin`. If you've lost admin access:

```bash
# Promote a user by email
docker exec vardo-postgres psql -U host host -c \
  "UPDATE \"user\" SET \"isAppAdmin\" = true WHERE email = 'you@yourdomain.com';"
```
