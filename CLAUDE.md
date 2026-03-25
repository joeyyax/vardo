# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Host -- a self-hosted PaaS for managing Docker Compose deployments. Built on Next.js with a PostgreSQL + Redis backend.

## Tech Stack

- Next.js 16 (App Router, Server Actions)
- Tailwind CSS + shadcn/ui
- PostgreSQL + Redis (Docker Compose for dev)
- Drizzle ORM
- Better Auth (passkey, OAuth, magic link + 2FA)

## Commands

```bash
# Development
pnpm dev              # Start dev server (Turbopack)
pnpm db:push          # Push schema changes to database
pnpm db:studio        # Open Drizzle Studio
pnpm db:migrate       # Run migrations

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
  /api
    /auth/[...all]                 # Better Auth handler
    /v1/organizations/[orgId]/...  # Versioned REST API (authenticated, org-scoped)
  /(app)                           # Authenticated routes (projects, settings)
  /(public)                        # Public routes (login)
/components
  /ui                              # shadcn components
  /layout                          # Sidebar, mobile sidebar, org switcher
/lib
  /db                              # Drizzle schema + queries
  /auth                            # Better Auth config
/config                            # Loki, Promtail configs
/docs                              # ADRs, API docs
```

### Key Concepts

- **Projects**: Docker Compose deployments managed through the UI
- **Multi-tenant**: All queries scoped by `organization_id`
- **API-first**: Data access through `/api/v1/` endpoints

## UI Components

### Toasts (Sonner)

Use `toast` from `sonner` for notifications:

```tsx
import { toast } from "sonner";

toast.success("Changes saved");
toast.error("Failed to save");
toast.promise(saveData(), {
  loading: "Saving...",
  success: "Saved!",
  error: "Failed to save",
});
```

### Squircle Styling

Apply `className="squircle"` to buttons, cards, dialogs for consistent rounded corners.
