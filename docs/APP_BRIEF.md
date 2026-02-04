# Time Tracker - App Brief

A time tracking app for freelancers and small teams, replacing Toggl with a focused, keyboard-first experience. No timer - just quick manual entry with smart suggestions.

## Core Concept

- Manual time entry (no timer clutter)
- Duration rounded to configurable increments (default: 15 min)
- Quick search with recent + smart suggestions (learns patterns)
- API-first for data liberation
- Multi-tenant from day one, SaaS-ready

## Data Model

```
Organization (tenant)
├── Members (users with roles)
├── Settings (default rate, rounding increment)
├── Clients
│   ├── rate_override (nullable)
│   ├── is_billable (default: inherit)
│   └── Projects
│       ├── rate_override (nullable)
│       ├── is_billable (default: inherit)
│       └── Tasks
│           ├── rate_override (nullable)
│           └── is_billable (default: inherit)
└── Time Entries
    ├── user_id
    ├── task_id (→ implies project → client)
    ├── description
    ├── date
    ├── duration_minutes
    ├── is_billable (computed or override)
    └── created_at
```

**Rate Resolution:** Walk up the tree (Task → Project → Client → Org Settings). First non-null rate wins. Same logic for `is_billable`. Any level can override or mark as non-billable.

## Tech Stack

- **Next.js 16** (App Router, Server Actions)
- **Tailwind CSS + shadcn/ui**
- **PostgreSQL** - Primary data store
- **Redis** - Sessions, rate limiting, caching suggestions
- **Drizzle ORM** - Type-safe database access
- **Better Auth** - Authentication
- **Resend + React Email** - Transactional email
- **Docker Compose** - Local dev (Postgres + Redis)

## Authentication

**Methods:**
- Passkey (WebAuthn) - primary, most secure
- GitHub / Google OAuth
- Email magic link - requires 2FA if enabled

**2FA (no SMS):**
- TOTP (authenticator apps)
- Security keys (WebAuthn as second factor)

## Project Structure

```
/app
  /api/v1/[...routes]     # API endpoints
  /(app)                   # Authenticated app routes
    /track
    /reports
    /clients
    /projects
    /settings
  /(public)
    /r/[slug]             # Public report pages
    /login
/components
  /ui                     # shadcn components
  /entry                  # Entry bar, entry row
  /timeline               # Day groups, week nav
/lib
  /db                     # Drizzle schema + queries
  /api                    # API client for frontend
  /auth                   # Session management
  /email                  # React Email templates
/docker-compose.yml
```

## API Structure

```
/api/v1/
├── /auth
│   ├── POST /magic-link
│   └── POST /verify
├── /organizations/:orgId
│   ├── GET/PATCH /settings
│   ├── /clients              # CRUD
│   ├── /projects             # CRUD
│   ├── /tasks                # CRUD
│   ├── /entries              # CRUD + bulk
│   │   ├── GET    ?from=&to=&client=&project=
│   │   ├── POST   (single or batch)
│   │   └── GET /export?format=csv&from=&to=
│   ├── /reports              # Report configs
│   └── /members              # User management
└── /reports/:slug            # Public report access (no auth)
```

**Suggestions Endpoint:**
```
GET /api/v1/organizations/:orgId/suggestions
  ?query=           # optional search text
  &context=dow,hour # day-of-week, hour for pattern matching
```

Returns ranked list of `{ client, project, task, score, reason }`.

## UI Layout

```
┌─────────────────────────────────────────────────────────┐
│ Entry Bar: [Description] [Project/Task ▾] [Duration] [+]│
├────────┬────────────────────────────────────────────────┤
│        │  ◀ Week of Jan 27 ▶    Today: 2:30  Week: 18:45│
│ Nav    │────────────────────────────────────────────────│
│        │  Wed, Jan 28                              2:30 │
│ Track  │    WP updates • Acme / Website        $  0:30 │
│ Reports│    Bug fix • Acme / App               $  1:00 │
│ Clients│                                                │
│ Projects│  Tue, Jan 27                             5:30 │
│ Settings│    Meeting • Beta Corp / Retainer    $  1:00 │
│        │                                                │
│────────│                                                │
│ [Org ▾]│                                                │
│ [User] │                                                │
└────────┴────────────────────────────────────────────────┘
```

**Navigation (Left Sidebar):**
- Track - Main timeline view (home)
- Reports - Manage report configs, preview, send
- Clients - CRUD clients
- Projects - CRUD projects (filterable by client)
- Settings - Org settings, rates, rounding, members
- Org switcher + User menu at bottom

## Entry Bar & Keyboard Navigation

**Quick Entry Flow:**
1. Type in search field → API returns matches (recent → patterns → text match)
2. Results show as `Client / Project / Task` with visual hierarchy
3. `↓/↑` navigate results → `Enter` selects
4. `Tab` advances: search → description → duration → save
5. `Shift+Tab` to go back
6. `$` hotkey toggles billable
7. `Cmd/Ctrl+Enter` saves from anywhere
8. `Escape` clears/cancels

Entire entry completable without mouse.

## Timeline Interactions

- Click description → edit inline
- Click project/task → opens quick search picker
- Click duration → edit inline
- Click billable ($) → toggle
- Hover reveals: delete, duplicate icons
- Drag entry to different day → updates date

All fields editable in place, no modal needed.

## Reports

**URLs:**
```
/r/:slug                    # Client report (all projects)
/r/:slug/:projectSlug       # Project-specific report
```

Slugs are random, unguessable strings. No auth required.

**Report View:**
- Date range selector (default: current week)
- Navigate between weeks/months
- Entries grouped by day or by project (toggle)
- Totals: hours, billable amount (can hide rates from clients)
- Print-friendly styling

**Report Config (per client/project):**
- `enabled` - whether the report URL is active
- `show_rates` - whether to display dollar amounts
- `auto_send` - optional weekly email schedule
- `recipients` - email addresses

**Email:**
- Weekly summary with key stats
- "View full report" links to web report
- Triggered by cron or manual send

## Multi-tenancy & Roles

**Tenant Isolation:**
- All queries scoped by `organization_id`
- Middleware validates org membership
- `orgId` from session context, never user input for writes

**Roles:**
- **Owner** - Full access, billing, can delete org
- **Admin** - Manage clients/projects/members, view all entries
- **Member** - Track own time, view own entries

## SaaS & Billing (Future)

**Data Model Hooks:**
- `organizations.plan` - free, pro, etc.
- `organizations.limits` - JSON for plan-specific limits
- Metered usage: entries count, report email sends, API calls
- `canUseFeature(org, 'feature-name')` abstraction

**Potential Gates:**
- Number of clients/projects (generous free tier)
- Auto-send reports (costs email sends)
- API access (costs compute)
- Multiple members (solo is free, team is paid)

**Philosophy:** Solo freelancer or small team with a few clients uses this free. Paid tiers unlock scale features and higher limits.

## Implementation Phases

### Phase 1 - Core (MVP)
1. Auth (Better Auth: passkey, OAuth, magic link + 2FA)
2. Org/Client/Project/Task CRUD
3. Time entry with quick search
4. Timeline view with inline editing
5. Basic settings (rate, rounding increment)

### Phase 2 - Reports
6. Report configs and public report pages
7. Date range navigation and grouping
8. CSV export

### Phase 3 - Polish & Email
9. Smart suggestions (recent + patterns)
10. Email templates (React Email)
11. Manual report sending via Resend
12. Auto-send scheduling

### Phase 4 - SaaS Prep
13. Plan/limits infrastructure
14. Usage tracking
15. Billing integration (Stripe)
16. Landing page / marketing site
