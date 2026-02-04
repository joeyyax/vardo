# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Time tracking app for freelancers. Manual entry (no timer), keyboard-first UX, API-driven. Replacing Toggl with something focused.

See `docs/APP_BRIEF.md` for full design spec.

## Tech Stack

- Next.js 16 (App Router, Server Actions)
- Tailwind CSS + shadcn/ui
- PostgreSQL + Redis (Docker Compose for dev)
- Drizzle ORM
- Better Auth (passkey, OAuth, magic link + 2FA)
- Resend + React Email

## Commands

```bash
# Development
pnpm dev              # Start Next.js dev server
pnpm db:push          # Push schema changes to database
pnpm db:studio        # Open Drizzle Studio

# Docker (Postgres + Redis)
docker compose up -d  # Start services
docker compose down   # Stop services

# Code quality
pnpm lint             # ESLint
pnpm typecheck        # TypeScript check
pnpm test             # Run tests
```

## Architecture

```
/app
  /api/v1/[...routes]   # REST API (all data access)
  /(app)                # Authenticated routes (track, reports, clients, projects, settings)
  /(public)             # Public routes (/r/[slug] for reports, /login)
/components
  /ui                   # shadcn components
  /entry                # Entry bar, entry row
  /timeline             # Day groups, week nav
/lib
  /db                   # Drizzle schema + queries
  /api                  # API client for frontend
  /auth                 # Better Auth config
  /email                # React Email templates
```

## Data Model

Client → Project → Task hierarchy. Rate inheritance walks up the tree (Task → Project → Client → Org Settings).

Multi-tenant: all queries scoped by `organization_id`.

## Key Patterns

- **API-first**: All data through `/api/v1/` endpoints
- **Keyboard-first entry**: Full entry flow without mouse
- **Inline editing**: Click any field in timeline to edit
- **Smart suggestions**: Recent usage + time-of-week patterns
