# Time Tracker - App Brief

A time tracking and project management app for freelancers and small teams, replacing Toggl with a focused, keyboard-first experience. No timer - just quick manual entry with smart suggestions.

## Core Concept

- Manual time entry (no timer clutter)
- Duration rounded to configurable increments (default: 15 min)
- Quick search with recent + smart suggestions (learns patterns)
- API-first for data liberation
- Multi-tenant from day one, SaaS-ready
- Modular features - enable only what you need

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

## Feature Flags

Organizations can enable/disable features via `features` JSON field:

- `time_tracking` - Core time tracking, timeline, entries
- `invoicing` - Invoice generation, management, PDF
- `expenses` - Expense tracking, receipts, recurring expenses
- `pm` - Project management with tasks, kanban, assignments
- `proposals` - Proposals and contracts

Default: `{ time_tracking: true, invoicing: true, expenses: true, pm: false, proposals: false }`

## Data Model

```
Organization (tenant)
├── Members (users with roles: owner, admin, member)
├── Settings (default rate, rounding increment, billing defaults)
├── Features (feature flags)
├── Clients
│   ├── parent_id (nullable, for nesting)
│   ├── rate_override (nullable)
│   ├── is_billable (default: inherit)
│   ├── billing_type, billing_frequency, retainer_amount
│   └── Projects
│       ├── rate_override (nullable)
│       ├── is_billable (default: inherit)
│       ├── stage (lead/proposal_sent/active/completed)
│       ├── budget tracking (hours or fixed)
│       └── Tasks
│           ├── rate_override (nullable)
│           ├── is_billable (default: inherit)
│           ├── status (todo/in_progress/review/done) - PM only
│           ├── assigned_to, created_by
│           ├── type, tags, estimate, metadata
│           └── relationships (blocked_by, related_to)
├── Time Entries
│   ├── user_id
│   ├── client_id (required)
│   ├── project_id, task_id (optional)
│   ├── description, tags (extracted from #hashtags)
│   ├── date, duration_minutes
│   ├── is_billable_override
│   └── recurring_template_id
├── Recurring Templates (for automated entries)
├── Invoices
│   ├── line items (snapshot of project/task names)
│   └── public_token for client access
├── Documents (proposals & contracts)
│   └── public_token for client signing
├── Expenses (project-specific or overhead)
│   ├── receipt file attachment
│   └── recurring support
├── Project Files (R2 storage)
├── Activities (global audit log)
└── Notifications (user inbox)
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
- **Redis** - Sessions, rate limiting, caching suggestions
- **Drizzle ORM** - Type-safe database access
- **Better Auth** - Authentication (passkey, OAuth, magic link + 2FA)
- **Resend + React Email** - Transactional email
- **Cloudflare R2** - File storage
- **Docker Compose** - Local dev (Postgres + Redis)

## Architecture Principles

- **API-first** - All data through REST endpoints for data liberation
- **Keyboard-first** - Full workflows without mouse
- **Feature flags** - Modular functionality, enable what you need
- **Multi-tenancy** - All queries scoped by `organization_id`

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
  /api/cron               # Cron jobs (auto-invoices, reports, recurring)
  /api/portal             # Client portal public routes
  /api/documents          # Public document access
  /(app)                  # Authenticated app routes
    /track                # Timeline view (home)
    /reports              # Analytics dashboard
    /invoices             # Invoice management
    /proposals            # Proposals list
    /contracts            # Contracts list
    /expenses             # Expense tracking
    /clients              # Client management
    /clients/[id]         # Client dashboard
    /projects             # Project management
    /projects/[id]        # Project dashboard (with PM features)
    /tasks                # All tasks across projects
    /settings             # Org settings
    /profile              # User profile
    /onboarding           # New user/org onboarding
  /(public)
    /r/[slug]             # Public report pages
    /i/[token]            # Public invoice view
    /d/[token]            # Public document view
    /login
/components
  /ui                     # shadcn components
  /layout                 # Sidebar, nav, entry bar
  /entry                  # Smart entry bar, chips input
  /timeline               # Day groups, week nav, entry rows
  /invoices               # Invoice dialogs, list
  /clients                # Client dialogs
  /projects               # Project dialogs, kanban, task lists
  /documents              # Document editor, dialogs
  /expenses               # Expense dialogs, rows
  /settings               # Import wizards, Toggl integration
/lib
  /db                     # Drizzle schema + queries
  /api                    # API client for frontend
  /auth                   # Better Auth config
  /email                  # React Email templates
  /invoices               # Invoice generation, PDF, auto-generate
  /reports                # Auto-send reports
  /integrations           # Toggl import
  /expenses               # Recurring expense logic
```

## Navigation

**Sidebar Navigation (feature-gated):**
- Track - Main timeline view (time_tracking)
- Reports - Analytics & summaries (time_tracking)
- Invoices - Manage invoices (invoicing)
- Proposals - Track proposals (proposals)
- Contracts - Manage contracts (proposals)
- Expenses - Track expenses (expenses)
- Clients - Manage clients (always visible)
- Projects - Manage projects (time_tracking OR pm)
- Tasks - All tasks across projects (pm)
- Settings - Organization settings

## API Structure

```
/api/v1/
├── /organizations
│   ├── POST /              # Create organization
│   ├── GET /:orgId         # Get org details
│   ├── PATCH /:orgId       # Update org
│   ├── /clients            # CRUD + reorder (drag-drop hierarchy)
│   ├── /projects           # CRUD
│   ├── /tasks              # CRUD (global tasks)
│   ├── /entries            # CRUD + bulk + export
│   ├── /recurring-templates # CRUD
│   ├── /invoices           # CRUD + generate + send
│   ├── /expenses           # CRUD + export
│   ├── /reports            # Report configs + analytics
│   ├── /report-presets     # Saved filter configs
│   ├── /documents          # Proposals & contracts
│   ├── /activities         # Global activity log
│   ├── /suggestions        # Entry suggestions
│   ├── /entry-suggestions  # Alternative suggestions endpoint
│   ├── /content            # Content for selectors
│   ├── /analytics          # Dashboard analytics
│   ├── /imports            # Toggl import sessions
│   ├── /integrations/toggl # Toggl API integration
│   ├── /task-types         # PM task types
│   └── /task-tags          # PM task tags
├── /notifications          # User notifications
├── /notifications/preferences
└── /reports/:slug          # Public report access

/api/cron/
├── /                       # Cron health check
├── /generate-invoices      # Daily auto-invoice generation
├── /send-reports           # Weekly auto-report sending
└── /recurring-expenses     # Daily recurring expense creation

/api/portal/
├── /projects/:id           # Client portal project view
└── /projects               # List accessible projects

/api/documents/:token       # Public document view/accept
/api/invitations/:token     # Accept project invitation
```

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
│ ...    │    Meeting • Beta Corp / Retainer    $  1:00 │
│────────│                                                │
│ [Org ▾]│                                                │
│ [User] │                                                │
└────────┴────────────────────────────────────────────────┘
```

**Top Bar:**
- Mobile menu button (mobile only)
- Entry bar (when time_tracking enabled, or mobile always)

**Sidebar:**
- Logo/brand with notification bell
- Navigation links (feature-gated)
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

**Client/Project/Task Selector:**
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

## Timeline Interactions

- Click description → edit inline
- Click project/task → opens quick search picker
- Click duration → edit inline
- Click billable ($) → toggle
- Hover reveals: delete, duplicate icons
- Drag entry to different day → updates date
- Recurring suggestions appear for matching patterns

All fields editable in place, no modal needed.

## Recurring Time Entries

Create templates that generate entries automatically:

- **Frequency:** daily, weekly, biweekly, monthly, quarterly
- **Day selection:** Day of week (weekly) or day of month (monthly)
- **Start date:** When to begin showing suggestions
- **Skip dates:** One-off skips (holidays, vacation)
- **Pause/Resume:** Temporarily disable without deleting

Recurring entries appear as suggestions on the timeline. Click to apply, or dismiss for that occurrence.

## Reports & Analytics

**Navigation split:**
- `/reports` - Analytics dashboard (hours, revenue, trends)
- `/invoices` - Invoice management (create, send, track)

**Analytics Dashboard (`/reports`):**
- Period selector (week, month, quarter, year)
- Summary cards: total time, billable amount, active clients, avg hours/day
- Hours breakdown by client (with percentage bars)
- Weekly/monthly trends (charts)
- Export to CSV

**Saved Report Presets:**
- Save filter configurations for quick access
- User-specific, not org-wide
- Available in Overview, Accounting, and Client Reports tabs

**Public Report URLs:**
```
/r/:slug                    # Client report (all projects)
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

**Organization defaults:**
- `default_billing_type` - Default for new clients
- `default_billing_frequency` - Default frequency
- `default_payment_terms_days` - Net 30, etc.

## Invoices

**Invoice Management (`/invoices`):**
- List all invoices with status (draft, sent, viewed, paid)
- Create invoice: select client, date range, auto-populate line items
- Edit invoice: modify line items, descriptions, amounts
- Preview before sending
- Send via email with PDF attachment
- Track when viewed

**Invoice Types:**
- Standard invoices - Fixed billing period
- Rolling draft invoices - Continuously accumulate entries until finalized

**Public Invoice View (`/i/:token`):**
- Branded invoice display
- Download PDF option
- Mark as viewed on access

**Auto-generation:**
- Cron job runs daily (`/api/cron/generate-invoices`)
- Checks clients with `auto_generate_invoices = true`
- Creates invoice when billing cycle is due
- Updates `last_invoiced_date`

**Line Items:**
- Snapshot project/task names at time of invoice
- Group by project with optional task breakdown
- Editable descriptions

## Proposals & Contracts

**Document Types:**
- **Proposals** - Project scopes, pricing, timelines
- **Contracts** - Formal agreements with acceptance flow

**Document Editor:**
- Structured sections (intro, scope, deliverables, timeline, pricing, terms)
- Markdown content support
- Pricing tables for proposals
- E-signature flow for contracts

**Status Flow:**
- `draft` → `sent` → `viewed` → `accepted`/`declined`

**Public Access:**
- `/d/:token` - Client can view, download PDF, accept/decline
- Email notifications on send, view, accept, decline

## Expense Tracking

**Expense Management (`/expenses`):**
- Track project-specific or general business expenses
- Receipt upload and attachment
- Categories for grouping
- Billable toggle (pass through to client)
- Payment status tracking (paid/unpaid)

**Recurring Expenses:**
- Weekly, monthly, quarterly, yearly frequencies
- Auto-generate on schedule via cron
- End date or indefinite recurrence

**Expense Details:**
- Description, amount, date, category
- Vendor tracking
- Project association (optional)
- Comments/discussion on expenses
- Activity log

## Project Management (PM Feature)

**Kanban Board:**
- Columns: Todo, In Progress, Review, Done
- Drag-and-drop task management
- Swimlane view options

**Task Features:**
- Status workflow (todo → in_progress → review → done)
- Assignment to team members
- Task types (org-defined: Bug, Feature, Task, etc.)
- Tags (org-defined + ad-hoc hybrid)
- Estimates (time tracking)
- Due dates
- PR links
- Client visibility toggle

**Task Relationships:**
- `blocked_by` - Task cannot start until blocker resolved
- `related_to` - Loose coupling for context

**Task Comments:**
- Internal comments (team only by default)
- Share to client portal (make visible)
- @mentions support

**Task Watchers:**
- Auto-watch: creator, assignee, commenters
- Manual watch/unwatch
- Notifications on changes

**Project Files:**
- Upload to Cloudflare R2
- Tagging support
- Public/private visibility (client portal)
- Attach to tasks

**Project Activity Log:**
- Chronological feed of all project events
- Stage changes, task updates, file uploads
- Client-visible vs internal activities
- Activity timeline view

**Client Portal:**
- Invite clients via email
- Role-based access (viewer, contributor)
- Visibility controls (rates, time, costs)
- Public project view at `/portal/projects/:token`

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
- Stats cards: hours (month/all-time), revenue, budget remaining
- Kanban board (when PM enabled)
- Task list with filtering
- Documents (proposals/contracts)
- Expenses
- Files
- Activity timeline
- Team/invitations
- Quick actions: Edit, New Task, Upload File

**Client List (`/clients`):**
- Drag-and-drop for client hierarchy (nest/un-nest)
- Filter bar with search, sort by name/recent
- Client rows link to dashboards
- Inline edit button opens modal directly

**Project List (`/projects`):**
- Filter by client
- Project rows link to dashboards
- Stage badges (lead/proposal_sent/active/completed)
- Budget progress indicators
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

Connect via Toggl API token for quick import. Go to Settings → Import → Toggl API.

**Import Flow:**
1. Upload CSV or connect API
2. Preview: X clients, Y projects, date range
3. Map imported clients → existing clients or create new
4. Import with progress indicator
5. Summary of imported data

## Notifications

**Notification Types:**
- Assigned to task
- Mentioned in comment
- Task status changed
- New comment on watched task
- Blocker resolved
- Client comment

**Delivery:**
- In-app notification bell
- Email notifications (user preference)
- Real-time updates

**Preferences:**
- Per-type enable/disable
- Email on/off toggle

## Multi-tenancy & Roles

**Tenant Isolation:**
- All queries scoped by `organization_id`
- Middleware validates org membership
- `orgId` from session context, never user input for writes

**Roles:**
- **Owner** - Full access, billing, can delete org, manage features
- **Admin** - Manage clients/projects/members, view all entries
- **Member** - Track own time, view own entries

## Settings

**Organization Settings:**
- Name and slug
- Default rate and rounding increment
- Billing defaults (type, frequency, payment terms)
- Feature flags (enable/disable modules)
- Payment provider integration (Stripe, PayPal, Square)
- Toggl integration (API token, workspace)

**Personal Preferences:**
- Name and email
- Notification preferences
- Theme (system/light/dark)
- Default view modes (list/table preferences)

**Danger Zone:**
- Leave organization
- Transfer ownership (owners)
- Delete organization (owners)

## Cron Jobs

**Daily Jobs:**
- `/api/cron/generate-invoices` - Check for billing cycles due, create invoices
- `/api/cron/recurring-expenses` - Generate recurring expenses

**Weekly Jobs:**
- `/api/cron/send-reports` - Auto-send scheduled reports to clients

## Implementation Status

### Completed
- [x] Auth (Better Auth: passkey, OAuth, magic link + 2FA)
- [x] Org/Client/Project/Task CRUD
- [x] Time entry with quick search
- [x] Timeline view with inline editing
- [x] Basic settings (rate, rounding increment)
- [x] Report configs and public report pages
- [x] Date range navigation and grouping
- [x] CSV export
- [x] Invoice creation and management
- [x] Public invoice view
- [x] Invoice PDF generation
- [x] Client billing configuration
- [x] Client/project dashboards
- [x] Client hierarchy (parent/child with drag-drop)
- [x] Client list filters and sorting
- [x] Toggl import (API + CSV)
- [x] Feature flags system
- [x] Expense tracking
- [x] Recurring expenses
- [x] Proposals & contracts
- [x] Project management (tasks, kanban, assignments)
- [x] Task types and tags
- [x] Task relationships (blocked_by, related_to)
- [x] Project files (R2 storage)
- [x] Project activity log
- [x] Client portal with invitations
- [x] Notifications system
- [x] Recurring time entry templates
- [x] Auto-invoice generation (cron)
- [x] Auto-report sending (cron)
- [x] Command palette
- [x] Onboarding flow

### Future Ideas

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
- Time tracking reminders
- Budget alerts
- Team utilization reports
