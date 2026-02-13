# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Time tracking app for freelancers and small teams. Manual entry (no timer), keyboard-first UX, API-driven. Replacing Toggl with something focused.

See `docs/product/APP_BRIEF.md` for full design spec.

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
  /api
    /v1/organizations/[orgId]/...  # Versioned REST API (authenticated, org-scoped)
    /auth/[...all]                 # Better Auth handler
    /cron/                         # Scheduled jobs (send-reports, generate-invoices, recurring-expenses)
    /webhooks/stripe               # Stripe webhook receiver
    /portal/                       # Client portal API (external client auth context)
    /reports/[slug]                # Public report viewing (unauthenticated, token-based)
    /invitations/[token]           # Public invitation acceptance (unauthenticated)
    /documents/[token]             # Public document access (unauthenticated, share token)
  /(app)                           # Authenticated routes (track, reports, clients, projects, settings)
  /(public)                        # Public routes (/r/[slug] for reports, /login)
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

### API Route Structure

The `/api/v1/` prefix is for the versioned, authenticated REST API — all org-scoped data access goes here. Routes outside `/api/v1/` serve different purposes with different auth and access patterns:

| Path | Auth | Purpose |
|------|------|---------|
| `/api/v1/organizations/...` | Authenticated, org-scoped | Core data API |
| `/api/auth/` | Framework-managed | Better Auth catch-all |
| `/api/cron/` | Internal/scheduler | Scheduled background jobs |
| `/api/webhooks/` | Service-verified | External service callbacks |
| `/api/portal/` | Client token/session | Client-facing portal |
| `/api/reports/[slug]` | Unauthenticated | Public shared reports |
| `/api/invitations/[token]` | Unauthenticated | Invitation acceptance |
| `/api/documents/[token]` | Unauthenticated | Shared document access |

## Data Model

Client → Project → Task hierarchy. Rate inheritance walks up the tree (Task → Project → Client → Org Settings).

Multi-tenant: all queries scoped by `organization_id`.

## Key Patterns

- **API-first**: All data through `/api/v1/` endpoints
- **Keyboard-first entry**: Full entry flow without mouse
- **Inline editing**: Click any field in timeline to edit
- **Smart suggestions**: Recent usage + time-of-week patterns
- **Parent/child clients**: One level of nesting (e.g., Agency → End Client)
- **Drag-and-drop**: Clients can be nested/un-nested via drag-and-drop

## UI Components

### Toasts (Sonner)

Use `toast` from `sonner` for notifications:

```tsx
import { toast } from "sonner";

// Success
toast.success("Changes saved");

// Error
toast.error("Failed to save");

// With description
toast.success("Client created", {
  description: "Acme Corp has been added",
});

// Promise (auto-handles loading/success/error)
toast.promise(saveData(), {
  loading: "Saving...",
  success: "Saved!",
  error: "Failed to save",
});
```

### Squircle Styling

Apply `className="squircle"` to buttons, cards, dialogs for consistent rounded corners.

### Two-Panel Modal Pattern

Standard modal layout for entity detail dialogs (Tasks, Expenses, Projects, Clients, Invoices).

**Structure:**
- Full-size dialog with sticky header containing action buttons
- Left panel (flex-[2]): Content area with view/edit toggle
- Right panel (flex-1): Discussion sidebar with comments and activities

**Reference implementations:**
- `components/projects/task-dialog.tsx` - Full pattern with PM features
- `components/expenses/expense-detail-modal.tsx` - Simpler implementation

**Standard features:**
- View/edit mode toggle (existing entities start in view mode, new entities in edit mode)
- Sticky header with Edit/Archive/Delete icon buttons with tooltips
- Discussion sidebar with unified comment+activity timeline
- Client visibility toggle for comments (internal vs shared)
- Auto-subscribe watchers on comment creation
- Event bus integration for real-time updates

**Example:**
```tsx
<DialogContent size="full" className="squircle p-0 gap-0 overflow-hidden flex flex-col" showCloseButton={false}>
  {/* Sticky header */}
  <div className="sticky top-0 z-10 bg-muted/30 border-b px-6 py-4">
    <DialogHeader>
      <DialogTitle>Entity Details</DialogTitle>
    </DialogHeader>
    <div className="flex items-center gap-1">
      {/* Edit, Archive, Delete, Close icon buttons with Tooltips */}
    </div>
  </div>

  <div className="flex h-full min-h-0 flex-1">
    {/* Left: Content (2/3) */}
    <div className="flex-[2] overflow-y-auto p-6">
      {isEditing ? <EntityDetailEdit /> : <EntityDetailView />}
    </div>

    {/* Right: Discussion (1/3) */}
    <div className="flex-1 overflow-y-auto p-6 border-l bg-muted/40">
      <EntityComments />
    </div>
  </div>
</DialogContent>
```
