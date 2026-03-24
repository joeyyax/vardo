# Vardo Documentation

Vardo is a self-hosted PaaS for managing Docker Compose deployments. Deploy anything with Docker — from a GitHub repo, a Docker image, or a Compose file — with automatic TLS, blue-green deployments, and a web dashboard.

## Getting Started

- **[Installation](installation.md)** — Server requirements, one-command install, DNS setup, and manual installation.
- **[Getting Started](getting-started.md)** — First login, creating projects, deploying apps from templates, GitHub, or Docker images.
- **[Concepts](concepts.md)** — Projects, apps, environments, variable resolution, templates, notifications, backups, mesh networking, and how deployments work.

## Core Guides

- **[Deployment](deployment.md)** — Deploy types, blue-green strategy, rollbacks, group deploys, health checks, and environment variables.
- **[Backups](backups.md)** — Backup targets, jobs, retention policies, scheduler, and restoring volumes.
- **[Domains](domains.md)** — Custom domains, wildcard subdomains, TLS certificates, Cloudflare configuration, and domain monitoring.
- **[Monitoring](monitoring.md)** — Container metrics, log streaming, notification channels, and system health.

## Administration

- **[Admin Guide](admin-guide.md)** — System settings, user management, email configuration, GitHub App setup, feature flags, instance portability, and Traefik.
- **[Security](security.md)** — Authentication methods, rate limiting, encryption at rest, webhook verification, and hardening recommendations.
- **[Configuration](configuration.md)** — Environment variables, feature flags, `vardo.yml` config as code, and template format.

## Reference

- **[API Reference](api.md)** — Authentication, all endpoints, rate limits, and webhook format.
- **[CLI Reference](cli-reference.md)** — Full reference for the `install.sh` command-line interface and the planned `vardo` CLI tool.

## Tutorials

Step-by-step walkthroughs for common tasks:

- **[Deploy a Next.js App](tutorials/deploy-nextjs.md)** — From GitHub repository to live deployment with a custom domain.
- **[Set Up Backups](tutorials/setup-backups.md)** — Configure Cloudflare R2 backup storage and scheduled backup jobs.

## Contributing

- **[Contributing](contributing.md)** — Development setup, architecture overview, code quality guidelines, and contribution workflow.

## Product

- **[APP_BRIEF](product/APP_BRIEF.md)** — What Vardo is, who it's for, and what it solves.
- **[Why This Exists](product/why-this-exists.md)** — The motivation and context behind building Vardo.
- **[Product Philosophy](product/product-philosophy.md)** — Design and product decisions that shape how Vardo is built.
- **[Non-Goals](product/non-goals.md)** — What Vardo deliberately does not do.

## Architecture Decision Records

- **[ADR Index](adr/)** — Architectural decisions with context and rationale.
