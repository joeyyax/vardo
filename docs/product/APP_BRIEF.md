# Vardo — App Brief

## Purpose

Vardo is an opinionated, self-hosted platform for deploying and managing Docker applications. You bring a server, Vardo handles the rest.

It does one thing well: **get your apps running and keep them running**, without requiring you to become an infrastructure specialist.

---

## What Vardo Is

Vardo is a **self-hosted deployment platform** that handles the full set of concerns that come with running software in production:

- **Deployments** — blue/green, rollback, auto-deploy from Git
- **Networking** — reverse proxy, SSL, custom domains
- **Security** — authentication, encryption, rate limiting, org isolation
- **Backups** — automated snapshots, offsite storage, one-click restore
- **Monitoring** — container metrics, log aggregation, health checks
- **Environments** — dev, staging, production with promotion between them
- **Configuration** — portable config files, encrypted secrets
- **Scaling** — multi-instance mesh networking over WireGuard
- **Developer experience** — dashboard, CLI, API, AI agent integration

Each one is built on proven, foundational technology. No proprietary formats, no novel protocols, no reinvented wheels.

---

## What Vardo Is Not

Vardo is not:

- a Kubernetes distribution
- a CI/CD pipeline builder
- a serverless framework

Vardo uses Docker Compose — the same tool most developers already use locally — and makes it work seamlessly in production. No new abstractions to learn, no orchestration complexity to manage.

---

## Core Principles

### 1. Defaults beat configuration
Good defaults prevent mistakes better than unlimited options. Everything works without touching a config file.

### 2. You own everything
Your server, your data, your config. Export it, move it, fork it. No lock-in, no vendor dependency.

### 3. Built on proven technology
Git, Docker, Compose, S3, WireGuard, Let's Encrypt, PostgreSQL, Redis. Every piece is battle-tested, widely understood, and independently useful. If you stop using Vardo, everything it touches is still standard.

### 4. Nothing is an afterthought
Security, backups, monitoring, environments — these aren't add-ons or premium tiers. They're part of the platform from day one. If it matters in production, it should be there by default.

### 5. Explicit beats implicit
Deployments don't happen until triggered. Backups don't run until storage is configured. Nothing happens without intent.

### 6. Automation handles the operational work
SSL renewal, backup scheduling, health monitoring, notification retry — automated. Deployment decisions, rollbacks, scaling — yours.

### 7. Developer experience matters
The dashboard, CLI, and API aren't separate products. They're different views of the same platform. What you can do in the UI, you can do from a terminal or a script. The interface should make the right thing easy and the wrong thing hard.

---

## Deployments

Built on **Git** and **Docker**.

- Source: Git repository, Docker image, or Compose file
- Deploy types: Compose, Dockerfile, image, static, Nixpacks
- Blue/green deployments with automatic rollback on failure
- Persistent volumes survive redeploys
- Resource limits (CPU, memory) per app
- One-click rollback to any previous deployment

Deploy from a push, a button click, or an API call. The deploy engine handles cloning, building, health-checking, and routing.

---

## Networking & SSL

Built on **Traefik** and **Let's Encrypt**.

- Automatic HTTPS on every app — zero configuration
- Wildcard DNS for instant subdomains
- Custom domains with DNS verification
- Certificates issued and renewed automatically
- HTTP → HTTPS redirect by default

SSL isn't a setup step. It's what happens when you add a domain.

---

## Security

Built on **WebAuthn**, **AES-256-GCM**, and **Redis**.

- Passkey/WebAuthn as the primary auth method — phishing-resistant by default
- Secrets encrypted at rest
- All API endpoints authenticated and org-scoped
- Per-token rate limiting backed by Redis
- CSP headers on every response
- Org isolation — no cross-org data access, no admin backdoors
- Config secrets in a separate file with restricted permissions

Security isn't a feature you enable. It's the layer everything else runs on.

---

## Backups

Built on **S3-compatible storage** (R2, B2, S3, SSH).

- Apps with persistent volumes get daily snapshots by default
- Offsite storage — not on the same server as your apps
- Tiered retention: daily, weekly, monthly archives
- One-click restore from any snapshot
- Backups run live — no downtime, no container restarts

You don't configure backup infrastructure. You tell Vardo where to store them and it handles the rest.

---

## Monitoring

Built on **cAdvisor** and **Loki**.

- Container metrics: CPU, memory, disk usage
- Log aggregation across all apps
- System health dashboard: services, resources, runtime info
- Domain health monitoring with uptime tracking

No external monitoring stack required. If you want deeper observability, the data is there to export.

---

## Environments

Built on **Git branches** and **Docker Compose**.

- Production, staging, development, or custom environments
- Environment-specific variables and domains
- Promote between environments with one click
- Projects group related apps across environments

Environments aren't a separate product. They're how projects work.

---

## Configuration

Built on **YAML** and **portable file formats**.

- `vardo.yml` — settings (shareable, safe to commit)
- `vardo.secrets.yml` — keys and passwords (restricted permissions)
- Export from one instance, import on another
- One portable artifact for migration

No proprietary config format. No vendor-specific database you can't export from.

---

## Instance Mesh

Built on **WireGuard**.

- Connect multiple Vardo installations over encrypted tunnels
- **Promote** projects from dev to staging to production
- **Pull** what's running in production for local debugging
- **Clone** projects to new instances as fresh deployments
- Heartbeat monitoring across all connected instances

No Tailscale dependency. Pure WireGuard, self-contained.

---

## Developer Experience

Built on **REST**, **CLI**, and **MCP**.

### Dashboard
Web UI for managing everything — projects, apps, deployments, backups, settings. Designed to make the right action obvious and the current state honest.

### CLI
`vardo deploy`, `vardo rollback`, `vardo logs --follow`. Everything the dashboard does, from a terminal. Built for CI/CD pipelines and scripted workflows.

### API
REST API at `/api/v1/` with Bearer token auth. Every operation is an API call — the dashboard and CLI are both clients of the same API.

### AI Agent Integration
MCP server for AI agents. Manage your infrastructure from Claude, Cursor, or any MCP-compatible tool.

### Notifications
Email, webhook, and push channels with per-event filtering, delivery logging, and automatic retry. Weekly project health digest.

---

## Projects

Projects group related applications.

- Each project contains one or more apps (Docker Compose services)
- Projects carry shared configuration and environment variables
- Projects can be promoted, pulled, or cloned between instances

---

## Authentication

Built on **Better Auth** and **WebAuthn**.

- Passkeys (WebAuthn)
- Magic link
- GitHub OAuth
- Optional password auth (feature flag)
- Two-factor authentication
- API tokens for CI/CD and automation

---

## Intended Audience

Vardo is built for:

- indie developers running their own apps
- small teams that don't have (or want) a DevOps person
- homelab operators who want a proper deployment tool
- agencies managing client deployments across servers

People who know how to build software but don't want to specialize in running it.

---

## Design Language

- Clean
- Functional
- Honest
- No novelty UI
- No celebratory UX
- No gamification

Settings should be boring. Deployments should be obvious. Errors should be clear.

---

## Non-Goals

Vardo intentionally does not aim to:

- replace Kubernetes, Docker Swarm, or Nomad
- handle CI/CD pipelines (use GitHub Actions, GitLab CI)
- provide serverless or edge function hosting
- support multi-tenant SaaS hosting for end customers

---

## Pricing Philosophy

Pricing is:

- predictable
- flat
- transparent

Vardo does not:

- charge per container
- charge per deployment
- meter bandwidth
- lock core features behind plans

Open source core. Managed hosting for convenience. Enterprise tier for compliance.

Limits exist only to prevent abuse, not punish growth.

---

## Summary

Vardo exists to make deploying applications **simple and reliable**.

When Vardo is working well:

- you think about your product, not your infrastructure
- deployments are predictable
- backups happen without you thinking about them
- security is on by default
- your data is safe and portable
- nothing breaks silently

That is the product.
