# Scope

A time tracking app for freelancers and small teams. Manual entry (no timer), keyboard-first UX, API-driven.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start database
docker compose up -d

# Push schema
pnpm db:push

# Run dev server
pnpm dev
```

## First-Time Setup

The first user to create an organization becomes the **App Admin**. This user:

- Has the `isAppAdmin` flag set on their account
- Can manage app-wide settings (future feature)
- Is also the owner of their organization

Subsequent users can create their own organizations and become owners of those.

## Tech Stack

- **Next.js 16** - App Router, Server Actions
- **Tailwind CSS + shadcn/ui** - Styling
- **PostgreSQL + Redis** - Database and caching
- **Drizzle ORM** - Type-safe database access
- **Better Auth** - Authentication (passkey, OAuth, magic link)
- **Resend + React Email** - Transactional email

## Environment Variables

Copy `.env.example` to `.env` and configure:

### Required

```env
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/time

# Redis
REDIS_URL=redis://localhost:6379

# Auth
BETTER_AUTH_SECRET=your-secret-here
BETTER_AUTH_URL=http://localhost:3000

# Email (Resend)
RESEND_API_KEY=re_xxxx
EMAIL_FROM=Scope <noreply@yourdomain.com>
```

### Optional

```env
# OAuth (if using)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Cron jobs
CRON_SECRET=your-cron-secret
CRON_INVOICE_HOUR=14          # Hour to run invoice generation (0-23, default: 14 = 2pm)
TZ=America/Los_Angeles        # Timezone for cron scheduling

# Toggl import
# (API token entered per-user in settings)
```

## Commands

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm start        # Start production server
pnpm lint         # Run ESLint
pnpm typecheck    # Run TypeScript check
pnpm test         # Run typecheck + lint
pnpm test:e2e     # Run Playwright e2e tests
pnpm test:e2e:ui  # Run Playwright with interactive UI
pnpm db:push      # Push schema to database
pnpm db:studio    # Open Drizzle Studio
```

## Testing

### E2E Tests (Playwright)

End-to-end tests are in the `e2e/` directory. Playwright runs tests against a real browser.

```bash
# Run all e2e tests
pnpm test:e2e

# Run with interactive UI (useful for debugging)
pnpm test:e2e:ui

# Run specific test file
pnpm test:e2e e2e/auth.spec.ts

# Run in headed mode (see the browser)
pnpm test:e2e --headed
```

Tests automatically start the dev server if not already running.

### Writing Tests

```typescript
import { test, expect } from "@playwright/test";

test("example test", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading")).toContainText("Sign in");
});
```

## Cron Jobs

The app has a unified cron endpoint at `/api/cron` that handles:

- **Invoice generation** - Auto-generates invoices for clients with scheduled billing
- **Report sending** - Sends scheduled weekly reports to configured recipients

### Setup

Call the endpoint hourly with your cron secret:

```bash
# Example cron job (runs every hour at minute 0)
0 * * * * curl -H "Authorization: Bearer $CRON_SECRET" https://yourapp.com/api/cron
```

### Behavior

- Invoice generation runs once daily at `CRON_INVOICE_HOUR` (default: 2pm)
- Report sending checks every hour for reports scheduled at that time
- Each report config has its own day/hour settings

### Manual Trigger

```bash
# Force run all tasks regardless of time
curl -H "Authorization: Bearer $CRON_SECRET" "https://yourapp.com/api/cron?force=true"
```

## API Structure

```
/api/v1/
├── /organizations/:orgId
│   ├── /clients              # CRUD
│   ├── /projects             # CRUD
│   ├── /tasks                # CRUD
│   ├── /entries              # Time entries + export
│   ├── /invoices             # Invoice management
│   ├── /reports              # Report configs
│   ├── /analytics            # Dashboard stats
│   └── /integrations/toggl   # Toggl import
├── /reports/:slug            # Public report access (no auth)
└── /cron                     # Scheduled tasks
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` or `n` | Focus entry bar |
| `Cmd+K` | Open command palette |
| `Cmd+Enter` | Save entry (from anywhere in form) |
| `Escape` | Clear/cancel entry |
| `↑/↓` | Adjust duration by increment |
| `←/→` | Navigate date (when date picker focused) |
| `t` | Jump to today (when date picker focused) |

## Documentation

- [App Brief](docs/APP_BRIEF.md) - Full design spec
- [Execution Plan](docs/EXECUTION_PLAN.md) - Implementation phases
