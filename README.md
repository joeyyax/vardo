# Vardo

Self-hosted PaaS for managing Docker Compose deployments. Deploy anything with Docker — from a GitHub repo, Docker image, or Compose file — with automatic TLS, blue-green deployments, and a web dashboard.

## Features

- Deploy from GitHub, Docker images, or inline Compose files
- Automatic TLS via Let's Encrypt (Traefik)
- Blue-green deployments with zero-downtime rollback
- Preview environments from pull requests
- Built-in container metrics (cAdvisor) and log aggregation (Loki)
- Multi-tenant with org-scoped access control
- Scheduled backups to S3, R2, or B2
- Cron job management per app
- Domain monitoring with state transition alerts

## Install

```bash
curl -fsSL https://get.vardo.run | sudo bash
```

Requires Ubuntu 22.04+ or Debian 12+, 1 GB RAM, and a domain with DNS pointing to your server.

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

- [Installation](docs/installation.md)
- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md)
- [Configuration](docs/configuration.md)
- [API reference](docs/api.md)

## Development

```bash
pnpm install
docker compose up -d    # Postgres + Redis
pnpm db:push            # Apply schema
pnpm dev                # Start dev server
```

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

[MIT](LICENSE)
