# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vardo is a self-hosted PaaS for managing Docker Compose deployments. This is the main console application — a single Next.js instance that combines the dashboard UI, REST API, and Docker orchestration engine.

## Commands

```bash
# Development
pnpm dev                # Start dev server (Turbopack)
pnpm build              # Production build
pnpm start              # Production start (runs drizzle migrations first)

# Database (PostgreSQL via Drizzle ORM)
pnpm db:push            # Push schema changes to database
pnpm db:generate        # Generate migration files
pnpm db:migrate         # Run migrations
pnpm db:studio          # Open Drizzle Studio

# Code quality
pnpm typecheck          # TypeScript check
pnpm lint               # ESLint
pnpm test               # Full suite: typecheck + lint + vitest
pnpm test:e2e           # Playwright end-to-end tests

# Infrastructure
docker compose up -d    # Start Postgres + Redis + Traefik + cAdvisor + Loki
docker compose down     # Stop all services
```

## Architecture

### Route Groups

- `app/(authenticated)/` — protected routes requiring auth (projects, apps, settings, admin)
- `app/(public)/` — public routes (login, setup wizard, onboarding, invitations)
- `app/api/v1/` — versioned REST API, organized by resource under `/organizations/[orgId]/`
- `app/api/auth/[...all]/` — Better Auth handler

### Core Systems (under `lib/`)

- **`lib/db/schema/`** — Drizzle ORM schema. All data is multi-tenant, scoped by `organizationId`.
- **`lib/auth/`** — Better Auth config. Supports passkey (WebAuthn), TOTP 2FA, magic link, password, and GitHub OAuth. First user auto-promoted to admin.
- **`lib/docker/`** — Docker orchestration engine. Blue-green deployments with automatic rollback, compose parsing, container discovery, PR preview environments.
- **`lib/backup/`** — Backup system with S3, B2, SSH, and local storage adapters. Scheduled via cron with retention policies.
- **`lib/mesh/`** — Wireguard mesh networking for multi-node deployments. Peer management, heartbeats, config inheritance.
- **`lib/metrics/`** — Time-series metrics from cAdvisor. In-memory store with SSE streaming to frontend.
- **`lib/notifications/`** — Alert dispatch to email and webhook channels.

### Key Patterns

- **API-first**: All data flows through `/api/v1/` endpoints. Organization-scoped with membership-based access control.
- **Real-time**: SSE streams for deployment logs, container metrics, and notifications.
- **Secrets encryption**: AES-256-GCM via `ENCRYPTION_MASTER_KEY` for env vars, backup credentials, and deployment snapshots.
- **Deployments**: Store `envSnapshot` (encrypted) and `configSnapshot` (JSON) for rollback capability.
- **Compose decomposition**: Multi-service compose files create parent + child apps linked via `parentAppId` + `composeService`.

### Infrastructure (docker-compose.yml)

Full stack: PostgreSQL 17, Redis Stack 7.4, Traefik v3 (automatic TLS via DNS-01), cAdvisor, Loki + Promtail, Wireguard. Production Dockerfile installs Docker CLI, Nixpacks, and Railpack for build support.

## UI Components

### Toasts

Import from `@/lib/messenger`, not directly from `sonner` (enforced by ESLint):

```tsx
import { toast } from "@/lib/messenger";

toast.success("Changes saved");
toast.error("Failed to save");
```

### Squircle Styling

The `squircle` class provides consistent rounded corners. Base UI components (Button, Card, Dialog, etc.) should have it built into their component definitions — don't add it manually on every usage. If a component is missing it, fix the component.

### shadcn/ui

Components live in `components/ui/`. Add new ones via `pnpm dlx shadcn@latest add <component>`.
