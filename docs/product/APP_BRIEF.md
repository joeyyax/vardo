# Vardo — App Brief

## Purpose

Vardo is a calm, opinionated platform for deploying and managing Docker applications without the operational overhead.

It connects projects, deployments, backups, monitoring, and multi-instance management into a single, predictable workflow — without becoming an infrastructure-heavy tool or a Kubernetes alternative.

Vardo is designed to **reduce operational complexity**, not maximize configurability.

---

## What Vardo Is

Vardo is a **self-hosted deployment platform**.

It is built around the reality that running applications follows a sequence:

**Set Up → Connect → Deploy → Monitor → Back Up → Scale**

Vardo makes this lifecycle explicit and supports each stage with structure, defaults, and visibility — from the first install to multi-instance mesh networking.

---

## What Vardo Is Not

Vardo is not:

- a Kubernetes distribution
- a cloud provider abstraction layer
- an enterprise orchestration platform
- a CI/CD pipeline builder
- a serverless framework

Vardo does not attempt to abstract away Docker or replace existing infrastructure tools.

---

## Core Principles

### 1. Defaults beat configuration
Good defaults prevent mistakes better than unlimited options.

### 2. Calm is a feature
Nothing should surprise, nag, alert unnecessarily, or break silently.

### 3. Explicit beats implicit
Deployments don't happen until triggered. Backups don't run until configured. Vardo does not assume.

### 4. Automation supports judgment
Automation removes repetition; it does not replace decision-making.

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
- SSL certificates issued and renewed automatically

---

## Backups

Vardo protects data automatically.

### How It Works
- Apps with persistent volumes get daily snapshots by default
- Snapshots are stored offsite in S3-compatible storage
- Tiered retention: daily, weekly, monthly archives
- One-click restore from any snapshot

### What's Backed Up
- Everything in persistent volumes — databases, uploads, file storage
- Container images are not included — they're pulled from your registry on deploy

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

---

## Configuration

All non-infrastructure configuration lives in two files:

- `vardo.yml` — settings (shareable, safe to commit)
- `vardo.secrets.yml` — keys and passwords (0600 permissions)

Export from one instance, import on another. One portable artifact for migration.

---

## Monitoring

Built-in observability without external tools.

- Container metrics (CPU, memory, disk) via cAdvisor
- Log aggregation via Loki
- System health dashboard (services, resources, runtime)
- Domain health monitoring with uptime tracking

---

## Notifications

Vardo keeps users informed without being noisy.

- Email, webhook, and push notification channels
- Per-channel event filtering
- Delivery logging with retry on failure
- Weekly project health digest

---

## Authentication

Flexible, modern authentication.

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

- indie developers
- small teams
- homelab operators
- agencies managing client deployments

Especially people who:

- want to own their infrastructure
- are tired of PaaS lock-in
- need something simpler than Kubernetes
- want fewer decisions, not more options

---

## Design Language

- Quiet
- Neutral
- Functional
- No novelty UI
- No celebratory UX
- No gamification

Settings should be boring.
Deployments should be clear.
Monitoring may have light visual flair.

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
- calm

Vardo does not:

- charge per container
- charge per deployment
- meter bandwidth
- lock core features behind plans

Open source core. Managed hosting for convenience. Enterprise tier for compliance.

Limits exist only to prevent abuse, not punish growth.

---

## Summary

Vardo exists to make deploying applications feel **predictable and contained**.

When Vardo is working well:

- users think less about their infrastructure
- deployments are easier to reason about
- backups feel inevitable
- data feels safe
- nothing is surprising

That is the product.
