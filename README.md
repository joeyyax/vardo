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
