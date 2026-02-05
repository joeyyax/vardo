# Time Tracker - App Brief

A time tracking app for freelancers and small teams, replacing Toggl with a focused, keyboard-first experience. No timer - just quick manual entry with smart suggestions.

## Core Concept

- Manual time entry (no timer clutter)
- Duration rounded to configurable increments (default: 15 min)
- Quick search with recent + smart suggestions (learns patterns)
- API-first for data liberation
- Multi-tenant from day one, SaaS-ready

## Voice & Tone

**Personality:** Friendly and casual, but not silly. Like a helpful coworker, not a corporate robot or a chatbot trying too hard.

- Use plain language, avoid jargon
- Be encouraging without being patronizing
- Error messages should be helpful, not blaming
- Empty states should feel inviting, not empty
- Microcopy should have personality but stay functional

**Examples:**
- Good: "No time logged yet. Let's fix that."
- Bad: "No entries found in the database."
- Bad: "Woohoo! Time to track some time! 🎉"

## Design Language

**Feel:** Fresh, open, friendly, modern

- **Space** - Generous whitespace, don't crowd the UI
- **Motion** - Subtle, purposeful animations that feel responsive
  - Entry appears with a soft fade/slide
  - Buttons have gentle hover states
  - Transitions feel snappy (150-200ms), not sluggish
- **Color** - Clean palette, accent colors for key actions
- **Typography** - Clear hierarchy, readable at a glance

**Squircles:** Use the `.squircle` class alongside rounded classes for smoother corners (progressive enhancement - falls back gracefully). Example: `className="squircle rounded-lg"`

**Avoid:**
- Heavy drop shadows
- Overly rounded everything
- Gratuitous animations that slow you down
- Dark patterns or manipulative UI

## Feedback & Notifications

**Toast Notifications (Sonner):**
- Use for transient feedback (success, error, info)
- Position: bottom-right
- Auto-dismiss after ~4 seconds
- Don't overuse - only for meaningful state changes

**Usage patterns:**
```tsx
import { toast } from "sonner";

// Success feedback
toast.success("Client moved");
toast.success("Entry saved");

// Error feedback
toast.error("Failed to save changes");

// Promise wrapper (loading → success/error)
toast.promise(saveData(), {
  loading: "Saving...",
  success: "Saved!",
  error: "Failed to save"
});
```

**When to use:**
- Drag-and-drop actions (moved, nested, un-nested)
- Save/delete operations
- Import progress and completion
- Errors that don't need modal attention

**When NOT to use:**
- Every form submission (inline feedback is often better)
- Success for expected actions (only when confirming is helpful)
- Warnings that need acknowledgment (use dialog instead)

## Data Model

```
Organization (tenant)
├── Members (users with roles)
├── Settings (default rate, rounding increment)
├── Clients
│   ├── parent_id (nullable, for nesting)
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

**Client Hierarchy:**
- Clients can have one level of nesting (parent/child)
- Drag-and-drop to nest: drop on another client to make it a child
- Drag to root zone to un-nest (make top-level)
- Children displayed indented under their parent

**Rate Resolution:** Walk up the tree (Task → Project → Client → Org Settings). First non-null rate wins. Same logic for `is_billable`. Any level can override or mark as non-billable.

**Entry-Project Relationship:**
- When a project moves to a different client, all associated entries move with it
- This ensures time tracking data stays consistent with project organization

## Tech Stack

- **Next.js 16** (App Router, Server Actions)
- **Tailwind CSS + shadcn/ui**
- **PostgreSQL** - Primary data store
- **Redis** - Sessions, rate limiting, caching suggestions, pub/sub for real-time
- **Drizzle ORM** - Type-safe database access
- **Better Auth** - Authentication
- **Resend + React Email** - Transactional email
- **Docker Compose** - Local dev (Postgres + Redis)

## Architecture Principles

- **Event-driven over polling** - Use Redis pub/sub or Server-Sent Events for real-time updates. Avoid polling where possible.
- **API-first** - All data through REST endpoints for data liberation
- **Keyboard-first** - Full workflows without mouse

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
    /reports               # Analytics dashboard
    /invoices              # Invoice management
    /clients
    /clients/[id]          # Client dashboard
    /projects
    /projects/[id]         # Project dashboard
    /settings
  /(public)
    /r/[slug]             # Public report pages
    /i/[token]            # Public invoice view
    /login
/components
  /ui                     # shadcn components
  /entry                  # Entry bar, entry row
  /timeline               # Day groups, week nav
  /invoices               # Invoice components
  /analytics              # Charts and metrics
/lib
  /db                     # Drizzle schema + queries
  /api                    # API client for frontend
  /auth                   # Session management
  /email                  # React Email templates
  /invoices               # Invoice generation logic
  /integrations           # Toggl, etc.
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

**Client/Project Selector:**
- Tab into field → immediately ready to type (search)
- `↓/↑` navigate suggestions without typing
- First suggestion highlighted by default
- `Enter` selects, advances to duration

**Duration Input:**
- Smart parsing: `1`, `2`, `3` → hours (not minutes)
- Decimals work: `0.5` → 30m, `1.25` → 1h 15m, `1.5` → 1h 30m
- Explicit formats also work: `1h`, `30m`, `1h30m`, `1:30`
- `↑/↓` adjusts by rounding increment (e.g., 15m)
  - Example: enter `0.75` (45m), press `↑↑` → 1h 15m
- Displays rounded value after blur

**Date Picker:**
- `Enter` opens picker
- `←/→` navigate days, `↑/↓` navigate weeks
- `Enter` selects date
- `Escape` closes without selecting

## Command Palette (Cmd+K)

Optional power-user feature. Raycast-style command palette for quick actions.

**Trigger:** `Cmd/Ctrl+K` from anywhere

**Commands:**
- `track` / `new entry` - Focus entry bar
- `clients` / `projects` / `settings` - Navigate
- `new client` / `new project` - Open create dialog
- `[client name]` - Jump to client dashboard
- `[project name]` - Jump to project dashboard
- Recent entries for quick re-log

**Behavior:**
- Fuzzy search across commands and entities
- Results grouped: Actions, Navigation, Recent
- `↓/↑` to navigate, `Enter` to execute
- `Escape` to close

Not required for basic usage - all actions accessible via normal UI.

## Timeline Interactions

- Click description → edit inline
- Click project/task → opens quick search picker
- Click duration → edit inline
- Click billable ($) → toggle
- Hover reveals: delete, duplicate icons
- Drag entry to different day → updates date

All fields editable in place, no modal needed.

## Reports & Analytics

**Navigation split:**
- `/reports` - Analytics dashboard (hours, revenue, trends, utilization)
- `/invoices` - Invoice management (create, send, track)

**Analytics Dashboard (`/reports`):**
- Period selector (week, month, quarter, year)
- Summary cards: total time, billable amount, active clients, avg hours/day
- Hours breakdown by client (with percentage bars)
- Weekly/monthly trends (charts)

**Public Report URLs:**
```
/r/:slug                    # Client report (all projects)
/r/:slug/:projectSlug       # Project-specific report
```

Slugs are random, unguessable strings. No auth required.

**Report Config (per client/project):**
- `enabled` - whether the report URL is active
- `show_rates` - whether to display dollar amounts
- `auto_send` - optional weekly email schedule
- `recipients` - email addresses

## Client Billing Configuration

Clients have configurable billing settings that determine how invoices are generated.

**Billing Types:**
- `hourly` - Bill for actual hours worked (default)
- `retainer_fixed` - Flat fee per billing period
- `retainer_capped` - Hourly up to a maximum amount
- `retainer_uncapped` - Hourly with a baseline minimum
- `fixed_project` - One-time project fee

**Billing Frequency:**
- `weekly` / `biweekly` - Uses `billing_day_of_week` (0-6, Sunday=0)
- `monthly` / `quarterly` - Uses `billing_day_of_month` (1-31)
- `per_project` - Manual invoice generation

**Fields:**
- `billing_type` - See above (inherits org default if null)
- `billing_frequency` - See above
- `retainer_amount` - For retainer types (cents)
- `billing_day_of_week` / `billing_day_of_month` - When to bill
- `payment_terms_days` - Net X days (inherits org default if null)
- `auto_generate_invoices` - Auto-create invoices on schedule
- `last_invoiced_date` - Track billing cycles

**Organization defaults:**
- `default_billing_type` - Default for new clients
- `default_billing_frequency` - Default frequency
- `default_payment_terms_days` - Net 30, etc.

## Invoices

**Invoice Management (`/invoices`):**
- List all invoices with status (draft, sent, viewed)
- Create invoice: select client, date range, auto-populate line items
- Preview before sending
- Send via email with PDF attachment
- Track when viewed

**Public Invoice View (`/i/:token`):**
- Branded invoice display
- Download PDF option
- Mark as viewed on access

**Auto-generation:**
- Cron job runs daily
- Checks clients with `auto_generate_invoices = true`
- Creates invoice when billing cycle is due
- Updates `last_invoiced_date`

**Line Items:**
- Snapshot project/task names at time of invoice
- Group by project with optional task breakdown
- AI-generated descriptions (optional)

## Client & Project Dashboards

**Client Dashboard (`/clients/:id`):**
- Header: name, color, billing type indicator
- Stats cards: hours (month/all-time), revenue, outstanding invoices
- Active projects list (clickable)
- Recent entries (last 10, clickable → navigates to `/track?date=&entry=`)
- Outstanding invoices with status
- Quick actions: Edit, New Project, New Invoice

**Project Dashboard (`/projects/:id`):**
- Header: name, client badge, code, archive status
- Stats cards: hours (month/all-time), revenue, budget remaining (if set)
- Tasks with hours breakdown
- Recent entries (last 10, clickable → navigates to `/track?date=&entry=`)
- Quick actions: Edit, New Task

**Client List (`/clients`):**
- Drag-and-drop for client hierarchy (nest/un-nest)
- Filter bar with:
  - Search: filter by client name
  - Sort by: Name (alphabetical) or Recent (by last entry)
  - Sort order: Ascending/Descending toggle
- Client rows link to dashboards
- Inline edit button opens modal directly

**Project List (`/projects`):**
- Filter by client
- Project rows link to dashboards
- Inline edit button opens modal directly

## Toggl Import

Import clients and projects from Toggl Track for migrating users.

**How to Import:**

1. Go to Toggl → Settings → Data Export
2. Select: **Projects** and **Clients**
3. Click "Export to email"
4. Download the zip file from your email
5. Upload the zip in Settings → Import

**What gets imported:**

- Client names
- Project names with client associations
- Hourly rates (converted to cents)
- Billable status
- Project estimates and actual hours tracked
- Active/archived status
- Colors

**Alternative: API Import**

You can also connect via Toggl API token for a quick import. Go to Settings → Import → Toggl API.

**Import Flow:**
1. Upload CSV or connect API
2. Preview: X clients, Y projects, Z entries, date range
3. Map imported clients → existing clients or create new
4. Map projects with client associations
5. Import with progress indicator
6. Summary of imported data

**API Routes:**
```
POST /imports              # Create import session from CSV/API data
GET  /imports              # List in-progress imports
GET  /imports/:id          # Get import session details
PATCH /imports/:id         # Update mappings, advance steps
POST /imports/:id/execute  # Run the import
```

**Toggl API notes:**
- Base: `https://api.track.toggl.com/api/v9`
- Auth: Basic `{api_token}:api_token`
- Rate limit: Handle with delays between batches

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

### Phase 1 - Core (MVP) ✓
1. Auth (Better Auth: passkey, OAuth, magic link + 2FA)
2. Org/Client/Project/Task CRUD
3. Time entry with quick search
4. Timeline view with inline editing
5. Basic settings (rate, rounding increment)

### Phase 2 - Reports & Invoices ✓
6. Report configs and public report pages
7. Date range navigation and grouping
8. CSV export
9. Invoice creation and management
10. Public invoice view

### Phase 3 - Client Management ✓
11. Client billing configuration
12. Client/project dashboards
13. Client hierarchy (parent/child with drag-drop)
14. Client list filters and sorting
15. Toggl import (API + CSV)

### Phase 4 - Polish & Automation
16. Smart suggestions (recent + patterns)
17. Auto-invoice generation (cron)
18. Email templates (React Email)
19. Manual report/invoice sending via Resend

### Phase 5 - SaaS Prep
20. Plan/limits infrastructure
21. Usage tracking
22. Billing integration (Stripe)
23. Landing page / marketing site

## Future Ideas

Ideas to explore later, not part of initial implementation:

**Calendar Integration:**
- Connect Google Calendar (OAuth), possibly others later
- iCal feed import as a simpler alternative
- Suggestions from calendar events ("Did you work on this meeting?")
- Match/link time entries to calendar events
- Pre-fill entry from event (duration, description from event title)

**Other ideas to consider:**
- Mobile app (React Native, leveraging API-first architecture)
- CLI tool for quick entry from terminal
- Browser extension for one-click tracking
- Integrations (Slack, Linear, GitHub issues)
