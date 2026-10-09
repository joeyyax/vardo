# Vardo

Self-hosted PaaS for managing Docker Compose deployments. Deploy anything with Docker, from a GitHub repo, Docker image or Compose file, with automatic TLS, blue-green deployments and a web dashboard.

## Features

- Deploy from GitHub, Docker images or inline Compose files
- Automatic TLS via Let's Encrypt (Traefik)
- Blue-green deployments with zero-downtime rollback
- Preview environments from pull requests
- Built-in container metrics (cAdvisor) and log aggregation (Loki, one tenant per org)
- Multi-tenant with org-scoped access control
- Scheduled backups to S3, R2, B2, SSH and local storage
- Cron job management per app
- Domain monitoring with state transition alerts

## Install

```bash
curl -fsSL https://vardo.run/install.sh | sudo bash
```

Requires Ubuntu 22.04+ or Debian 12+, 1 GB RAM and a domain with DNS pointing to your server.

### Install-time options

Set these as environment variables or flags. A fresh install writes them to `/opt/vardo/.env`. On update they're added only when missing; an existing value stays unless you pass it with `--set KEY=VALUE`. Token values are never printed.

| Variable | Flag | Value |
| --- | --- | --- |
| `VARDO_DOMAIN`, `VARDO_BASE_DOMAIN`, `ACME_EMAIL` | none | Dashboard domain, base domain for projects, TLS email |
| `VARDO_ROLE` | none | `production`, `staging` or `development` |
| `VARDO_DIR`, `VARDO_REF` | none | Install directory; branch, tag or commit |
| `ENCRYPTION_MASTER_KEY`, `BETTER_AUTH_SECRET` | none | Escrowed secrets for a rebuild |
| `VARDO_BACKUP_*` | `--restore` | Backup storage to restore from |
| `CF_DNS_API_TOKEN` | `--cf-dns-api-token` | Cloudflare token (Zone:DNS:Edit) for DNS-01 |
| `VARDO_TRUSTED_PROXIES` | `--trusted-proxies` | Comma-separated IPs or CIDRs of proxies in front of this box |
| `VARDO_CONSOLE_MIDDLEWARES` | `--console-middlewares` | Comma-separated `name@provider` Traefik middlewares |
| `VARDO_CONSOLE_CERT_RESOLVER` | `--console-cert-resolver` | Console certificate resolver, such as `le-dns` |

Other flags: `--unattended`, `--yes`, `--force`, `--dry-run`, `--verbose`, `--purge`, `--help`. See [Console lock](docs/console-lock.md) for what the last three options do.

```bash
CF_DNS_API_TOKEN=<token> VARDO_TRUSTED_PROXIES=10.90.0.2 VARDO_CONSOLE_MIDDLEWARES=cloudflare-only@file \
  VARDO_CONSOLE_CERT_RESOLVER=le-dns bash install.sh --yes
bash install.sh update --set VARDO_TRUSTED_PROXIES=10.90.0.3
```

Prefer the environment for the token; flag values show in `ps`. Changed values apply at the next deploy (`update --force` redeploys now).

### Docker address pools

Docker's default pools hold 31 networks, and every compose project that names no network takes one, two during a blue-green deploy. Past that, every deploy fails with `could not find an available, non-overlapping IPv4 address pool`.

On a host with no `/etc/docker/daemon.json`, the installer writes one with Docker's own ranges cut into `/24`s, about 4,000 networks. It never changes an existing `daemon.json`, so add the key yourself and restart Docker:

```json
"default-address-pools": [
  { "base": "172.17.0.0/16", "size": 24 },
  { "base": "172.18.0.0/15", "size": 24 },
  { "base": "172.20.0.0/14", "size": 24 },
  { "base": "172.24.0.0/13", "size": 24 },
  { "base": "192.168.0.0/16", "size": 24 }
]
```

Existing networks keep their subnets; new ones come from the pools.

## What you get

| Service | Purpose |
|---------|---------|
| Next.js app | Web dashboard and API |
| Traefik | Reverse proxy, automatic TLS |
| PostgreSQL | Application database |
| Redis | Caching, pub/sub, rate limiting |
| Loki | Log aggregation (optional) |
| cAdvisor | Container metrics (optional) |

## Tech stack

- Next.js 16 (App Router, Server Actions)
- Tailwind CSS + shadcn/ui
- Drizzle ORM
- Better Auth (passkey, OAuth, magic link + 2FA)

## Documentation

- [Installation](https://vardo.run/docs/installation)
- [Getting started](https://vardo.run/docs/getting-started)
- [Concepts](https://vardo.run/docs/concepts)
- [Configuration](https://vardo.run/docs/configuration)
- [API reference](https://vardo.run/docs/api-reference)
- [Disaster recovery](docs/disaster-recovery.md)
- [Migrating Vardo's own stack to the deploy engine](docs/self-deploy-migration.md)

## Development

```bash
pnpm install
cp .env.example .env
openssl rand -hex 32    # paste into ENCRYPTION_MASTER_KEY in .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev
```

`docker compose up -d` without service names also starts Traefik and WireGuard, which local dev doesn't need.

`scripts/db-snapshot.sh` saves and restores the app, project and domain tables for local dev. Run it without arguments for usage.

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

[MIT](LICENSE)
