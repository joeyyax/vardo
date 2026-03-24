# CLI & Install Reference

`install.sh` is the single entry point for managing your Vardo instance — install, update, diagnose, and remove.

## Installation

```bash
curl -fsSL https://get.vardo.dev/install | sudo bash
```

This is a one-shot command. If Vardo is already installed, re-running it opens the [interactive menu](#interactive-menu) instead.

### Requirements

- Ubuntu or Debian (production)
- macOS with Docker Desktop (development)
- 20GB+ free disk space
- Root access (Linux)

---

## Interactive Menu

When Vardo is already installed, running `sudo bash /opt/vardo/install.sh` (or re-running the install command) shows an interactive menu:

```
  ┌───────────────────┐
  │  1. Update Vardo  │
  │  2. Doctor        │
  │  3. Uninstall     │
  │  4. Exit          │
  └───────────────────┘
```

---

## Modes

### Install

Runs automatically on first install. Sequence:

1. **Preflight checks** — verifies Ubuntu/Debian, root access, available ports
2. **Swap setup** — creates a 2GB swapfile if total RAM < 2GB
3. **Packages** — installs `curl`, `git`, `unattended-upgrades`, Docker Engine + Compose plugin via `get.docker.com`
4. **Clone** — shallow-clones the Vardo repo to `/opt/vardo`
5. **Configuration** — prompts for domain, base domain, and Let's Encrypt email; generates secrets and writes `/opt/vardo/.env`
6. **Build & start** — runs `docker compose up -d` with `COMPOSE_PROFILES=production`
7. **Health wait** — waits up to 60 seconds for containers to pass health checks
8. **Seed templates** — loads default deployment templates
9. **Summary** — prints dashboard URL and setup wizard link

### Update

```bash
sudo bash /opt/vardo/install.sh
# Select: 1. Update Vardo
```

Or via `--yes` for unattended:

```bash
sudo bash /opt/vardo/install.sh update --yes
```

Sequence:

1. Fetches latest commits from origin
2. Dumps a pre-update database backup to `/opt/vardo/backups/pre-update-<timestamp>.sql`
3. Pulls via `git pull`
4. Rebuilds containers: `docker compose build`
5. Restarts services: `docker compose up -d`
6. Waits for health checks
7. Runs database migrations

**Rollback:** the update summary prints exact rollback commands including how to restore the pre-update SQL dump.

### Doctor

```bash
sudo bash /opt/vardo/install.sh doctor
```

Runs a full system health check and prints pass/warn/fail for each item:

| Check | What it verifies |
|-------|-----------------|
| **System** | OS version, architecture |
| **Swap** | Memory headroom |
| **Installation** | `/opt/vardo` exists, `.env` present, git repo intact, up to date |
| **Docker** | Docker daemon running, Compose available |
| **Containers** | All expected containers running and healthy |
| **PostgreSQL** | `pg_isready` responds |
| **Redis** | `redis-cli ping` returns `PONG` |
| **App** | `/api/health` returns 200 |
| **DNS** | `VARDO_DOMAIN` and `*.VARDO_BASE_DOMAIN` resolve to server IP |
| **TLS** | HTTPS certificate valid for `VARDO_DOMAIN` |
| **Disk** | Free space (warn < 20GB, fail if critically low) |

Exit summary:
- All clear — N checks passed
- Mostly healthy — N passed, N warning(s)
- Issues found — N passed, N warning(s), N failed

### Uninstall

```bash
sudo bash /opt/vardo/install.sh uninstall
```

Stops all Vardo containers. Data is preserved.

#### `--purge`

```bash
sudo bash /opt/vardo/install.sh uninstall --purge
```

Stops containers, removes Docker volumes (database, Redis, project data), and deletes `/opt/vardo`. Requires explicit confirmation. **This is irreversible.**

---

## Flags

| Flag | Description |
|------|-------------|
| `--unattended` | Skip all interactive prompts. Set required values via environment variables before running. |
| `--yes` | Auto-confirm prompts (less strict than `--unattended`; still asks for destructive operations) |
| `--purge` | Used with `uninstall` — removes all data and the installation directory |

### Unattended / CI installs

Set these environment variables before running with `--unattended`:

```bash
export VARDO_DOMAIN=host.example.com
export VARDO_BASE_DOMAIN=example.com
export ACME_EMAIL=you@example.com

curl -fsSL https://get.vardo.dev/install | sudo --preserve-env bash -s -- --unattended
```

---

## Generated Files and Directories

| Path | Description |
|------|-------------|
| `/opt/vardo/` | Installation root (git repo) |
| `/opt/vardo/.env` | Runtime configuration — never overwritten on re-install |
| `/opt/vardo/backups/` | Pre-update SQL dumps |
| `/var/lib/host/projects/` | Deployed project files (Docker volume mount) |

---

## Environment Variables

The installer generates `/opt/vardo/.env` on first install. Key variables:

| Variable | Description |
|----------|-------------|
| `VARDO_ROLE` | `development`, `staging`, or `production` |
| `VARDO_INSTANCE_ID` | RFC 4122 v4 UUID — uniquely identifies this instance |
| `COMPOSE_PROFILES` | Set to `production` by the installer; omit for dev |
| `DB_PASSWORD` | Generated randomly — 32-char alphanumeric |
| `BETTER_AUTH_SECRET` | Generated randomly — 48-char auth secret |
| `ENCRYPTION_MASTER_KEY` | Generated with `openssl rand -hex 32` |
| `GITHUB_WEBHOOK_SECRET` | Generated randomly |
| `VARDO_DOMAIN` | Dashboard domain, e.g. `host.example.com` |
| `VARDO_BASE_DOMAIN` | Wildcard base domain for deployed apps |
| `ACME_EMAIL` | Let's Encrypt registration email |
| `VARDO_PROJECTS_DIR` | Project files directory (default: `/var/lib/host/projects`) |

Application configuration (email providers, GitHub App, feature flags) lives in `vardo.yml` / the admin UI — not in `.env`.

---

## Docker Compose Services

With `COMPOSE_PROFILES=production`, all services start:

| Service | Container | Default Port |
|---------|-----------|-------------|
| Next.js app | `vardo-frontend` | — (behind Traefik) |
| PostgreSQL | `vardo-postgres` | 7100 |
| Redis | `vardo-redis` | 7200 |
| Traefik | `vardo-traefik` | 80, 443 |
| cAdvisor | `vardo-cadvisor` | 7300 |
| Loki | `vardo-loki` | 7400 |

In development (no `COMPOSE_PROFILES`), only Postgres, Redis, cAdvisor, and Loki start. Run the app with `pnpm dev`.

---

## Post-Install: Setup Wizard

After installation, the summary screen prints:

```
  Dashboard   https://host.example.com
  Setup       https://host.example.com/onboarding
```

The setup wizard walks through:

1. Create your admin account
2. Name your instance
3. Optionally connect a GitHub App for repo-based deployments

You can skip the GitHub App setup and configure it later under **Settings → Integrations**.
