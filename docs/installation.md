# Installation

## Prerequisites

- **Server**: Linux VPS or dedicated server (Ubuntu 22.04+ or Debian 12+ recommended)
- **RAM**: 1 GB minimum, 2 GB+ recommended for production
- **Disk**: 20 GB+ free space recommended
- **Domain**: A domain you control with access to DNS settings
- **Ports**: 22 (SSH), 80 (HTTP), 443 (HTTPS) must be accessible

Docker and Docker Compose are installed automatically by the install script if not already present.

## One-Command Install

```bash
curl -fsSL https://get.host.joeyyax.dev | sudo bash
```

The installer will prompt for three values:

1. **Dashboard domain** -- where the Vardo dashboard will be accessible (e.g. `host.example.com`)
2. **Base domain** -- the root domain used for auto-generated app subdomains (e.g. `example.com`)
3. **ACME email** -- the email address used for Let's Encrypt TLS certificates

## What the Installer Does

The install script performs the following steps, in order:

1. **Preflight checks** -- Verifies root access, OS version, RAM (minimum 1 GB), and available disk space.
2. **Swap file** -- Creates a 2 GB swap file on servers with less than 4 GB RAM, if no swap is already active.
3. **Unattended upgrades** -- Installs and enables automatic security updates.
4. **Firewall** -- Firewall configuration is left to the user. Docker publishes ports directly via iptables, bypassing ufw by default.
5. **Docker** -- Installs Docker and the Compose plugin if not already present, then configures log rotation (10 MB x 3 files per container).
6. **Git** -- Installs git if needed.
7. **Clone** -- Clones the Vardo repository to `/opt/vardo` (or pulls latest if already installed).
8. **Configuration** -- Prompts for domain, base domain, and ACME email. Generates random secrets for the database password, auth secret, encryption master key, webhook secret, and Traefik dashboard credentials. Writes everything to `/opt/vardo/.env.prod` with `chmod 600`.
9. **DNS validation** -- Detects the server's public IP and checks whether the dashboard domain resolves to it. Warns if DNS is not yet configured but allows continuing.
10. **Build and start** -- Runs `docker compose build` and `docker compose up -d` using the production compose file with the generated `.env.prod`.
11. **Health check** -- Waits up to 60 seconds for the app to respond on `/api/health`.
12. **Template seeding** -- Seeds the built-in service templates (PostgreSQL, Redis, MySQL, etc.) via an internal API call.

## DNS Setup

Before or after installation, create two DNS records pointing to your server's IP address:

| Type | Name | Value |
|------|------|-------|
| A | `host.example.com` | `<server-ip>` |
| A | `*.example.com` | `<server-ip>` |

The first record routes traffic to the Vardo dashboard. The wildcard record allows Vardo to automatically create subdomains for deployed apps (e.g. `myapp.example.com`).

DNS propagation typically takes a few minutes but can take up to 48 hours depending on your provider.

## Manual Installation

If you prefer not to use the install script:

```bash
# Clone the repository
git clone --depth 1 https://github.com/joeyyax/vardo.git /opt/vardo
cd /opt/vardo

# Copy and edit the environment file
cp .env.example .env.prod
# Edit .env.prod with your values -- see Configuration docs for details

# Build and start
docker compose --env-file .env.prod up -d
```

The production Docker Compose stack includes these services:

| Service | Description |
|---------|-------------|
| **host** | The Next.js application (port 3000 internal) |
| **postgres** | PostgreSQL 17 database |
| **redis** | Redis Stack server |
| **traefik** | Reverse proxy with automatic TLS via Let's Encrypt |
| **cadvisor** | Container resource monitoring |
| **loki** | Log aggregation |
| **promtail** | Log collector (ships Docker container logs to Loki) |

## Post-Install

After installation completes:

1. Visit `https://host.example.com` in your browser.
2. Create your account -- the first user is automatically promoted to admin.
3. Walk through the onboarding flow: optionally connect a GitHub App, then create your first organization.
4. Configure a GitHub App in Settings if you want to deploy from GitHub repositories (optional).

### Useful Commands

```bash
# View logs
docker compose -f /opt/vardo/docker-compose.yml --env-file /opt/vardo/.env.prod logs -f

# Restart
docker compose -f /opt/vardo/docker-compose.yml --env-file /opt/vardo/.env.prod restart

# Stop
docker compose -f /opt/vardo/docker-compose.yml --env-file /opt/vardo/.env.prod down

# Update
cd /opt/vardo && git pull && docker compose -f docker-compose.yml --env-file .env.prod up -d --build
```

### Backups

Back up these items regularly:

- **`.env.prod`** -- Contains all secrets (database password, auth secret, encryption key).
- **PostgreSQL data** -- `docker compose -f /opt/vardo/docker-compose.yml exec -T postgres pg_dumpall -U host > backup.sql`
- **Docker volumes** -- The `host_projects` volume contains deployment data.

Migrations run automatically on app startup via `drizzle-kit migrate`. There is no need to run migrations manually after updates.
