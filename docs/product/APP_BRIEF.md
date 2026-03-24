# Vardo — App Brief

## Purpose

Vardo is an opinionated, self-hosted platform for deploying and managing Docker applications. You bring a server, Vardo handles the rest — deployments, SSL, backups, monitoring, and multi-instance networking.

It does one thing well: **get your apps running and keep them running**, without requiring you to become an infrastructure specialist.

---

## What Vardo Is

Vardo is a **self-hosted deployment platform**.

It handles the full lifecycle of running applications:

**Set Up → Connect → Deploy → Monitor → Back Up → Scale**

Each stage has sensible defaults. You configure what you want, skip what you don't. Everything works out of the box.

---

## What Vardo Is Not

Vardo is not:

- a Kubernetes distribution
- a cloud provider abstraction layer
- an enterprise orchestration platform
- a CI/CD pipeline builder
- a serverless framework

Vardo runs Docker Compose on servers you control. It doesn't try to abstract away Docker or replace tools that already work.

---

## Core Principles

### 1. Defaults beat configuration
Good defaults prevent mistakes better than unlimited options. Everything works without touching a config file.

### 2. You own everything
Your server, your data, your config. Export it, move it, fork it. No lock-in, no vendor dependency.

### 3. Explicit beats implicit
Deployments don't happen until triggered. Backups don't run until storage is configured. Vardo doesn't assume.

### 4. Automation handles the boring parts
SSL renewal, backup scheduling, health monitoring — automated. Deployment decisions, rollbacks, scaling — yours.

### 5. Data is sacred
Backups, logs, and deployment history are never hidden, altered, or removed without explicit intent.

---

## Core Concepts

### Projects
Projects group related applications.

- Each project contains one or more apps (Docker Compose services)
- Projects carry shared configuration and environment variables
- Projects can be promoted, pulled, or cloned between instances

### Apps
Apps are the deployable units.

- Source: Git repository, Docker image, or Compose file
- Deploy types: Compose, Dockerfile, image, static, Nixpacks
- Blue/green deployments with automatic rollback on failure
- Persistent volumes survive redeploys
- Resource limits (CPU, memory) per app

### Environments
Multiple deployment environments per app.

- Production, staging, development, or custom
- Environment-specific variables and domains
- Promote between environments with one click

### Domains & SSL
Automatic HTTPS via Traefik and Let's Encrypt.

- Wildcard DNS for automatic subdomains
- Custom domains with DNS verification
- Certificates issued and renewed automatically — zero maintenance

---

## Backups

Vardo handles backups so you don't have to think about them.

### How It Works
- Apps with persistent volumes get daily snapshots by default
- Snapshots stored offsite in S3-compatible storage (R2, B2, S3)
- Tiered retention: daily, weekly, monthly archives
- One-click restore from any snapshot

### What's Backed Up
- Everything in persistent volumes — databases, uploads, file storage
- Container images aren't included — they're pulled from your registry on deploy

Backups run live. No downtime, no container restarts.

---

## Instance Mesh

Connect multiple Vardo installations over encrypted WireGuard tunnels.

- **Promote** projects from dev to staging to production
- **Pull** what's running in production for local debugging
- **Clone** projects to new instances as fresh deployments
- Heartbeat monitoring across all connected instances

### Instance Types
- **Persistent** (production, staging, homelab) — always on, deploy targets
- **Dev** (laptops, workstations) — ephemeral, connect outbound to a hub

No Tailscale dependency. Pure WireGuard, self-contained.

---

## Configuration

All non-infrastructure configuration lives in two files:

- `vardo.yml` — settings (shareable, safe to commit)
- `vardo.secrets.yml` — keys and passwords (0600 permissions)

Export from one instance, import on another. One portable artifact for migration. No vendor lock-in.

---

## Monitoring

Built-in observability. No Grafana stack required.

- Container metrics (CPU, memory, disk) via cAdvisor
- Log aggregation via Loki
- System health dashboard (services, resources, runtime)
- Domain health monitoring with uptime tracking

If you want deeper observability, the metrics are there to feed into your own tools.

---

## Notifications

- Email, webhook, and push notification channels
- Per-channel event filtering
- Delivery logging with retry on failure
- Weekly project health digest

---

## Authentication

Modern auth out of the box.

- Passkeys (WebAuthn)
- Magic link
- GitHub OAuth
- Optional password auth (feature flag)
- Two-factor authentication
- API tokens for CI/CD and automation

---

## CLI & API

Everything in the UI is available programmatically.

- REST API at `/api/v1/` with Bearer token auth
- CLI tool for CI/CD pipelines and scripted management
- MCP server for AI agent integration

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
- manage cloud provider resources (AWS, GCP, Azure)
- handle CI/CD pipelines (use GitHub Actions, GitLab CI)
- provide serverless or edge function hosting
- become a general-purpose infrastructure platform
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
- your data is safe and portable
- nothing breaks silently

That is the product.
