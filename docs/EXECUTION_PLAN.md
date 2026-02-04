# Execution Plan

Implementation plan for the time tracking app. Tasks are ordered by dependency.

## Phase 1: Core Foundation

### 1.1 Better Auth Setup
- [ ] Configure Better Auth in `lib/auth/index.ts`
- [ ] Add passkey plugin, 2FA plugin, magic link plugin
- [ ] Create auth API route handler at `app/api/auth/[...all]/route.ts`
- [ ] Create auth client in `lib/auth/client.ts`
- [ ] Add session middleware

### 1.2 Database & Auth Tables
- [ ] Run Better Auth CLI to generate auth schema additions
- [ ] Merge auth tables with existing schema
- [ ] Run `pnpm db:push` to create tables
- [ ] Verify with `pnpm db:studio`

### 1.3 Login Page
- [ ] Create `app/(public)/login/page.tsx`
- [ ] Implement passkey sign-in
- [ ] Implement OAuth buttons (GitHub, Google)
- [ ] Implement magic link with email input
- [ ] Add 2FA verification flow

### 1.4 App Shell & Layout
- [ ] Create `app/(app)/layout.tsx` with sidebar
- [ ] Implement org switcher component
- [ ] Implement user menu component
- [ ] Add session protection middleware
- [ ] Create basic navigation structure

## Phase 2: CRUD Operations

### 2.1 Organization Setup
- [ ] Create org creation flow for new users
- [ ] Implement settings page at `app/(app)/settings/page.tsx`
- [ ] Add default rate and rounding increment settings
- [ ] Implement member management

### 2.2 Clients CRUD
- [ ] Create `app/(app)/clients/page.tsx` - list view
- [ ] Create client dialog/form component
- [ ] Implement API routes: GET, POST, PATCH, DELETE
- [ ] Add rate override and billable settings

### 2.3 Projects CRUD
- [ ] Create `app/(app)/projects/page.tsx` - list view with client filter
- [ ] Create project dialog/form component
- [ ] Implement API routes: GET, POST, PATCH, DELETE
- [ ] Add archive functionality

### 2.4 Tasks CRUD
- [ ] Tasks managed within project context
- [ ] Create task dialog/form component
- [ ] Implement API routes: GET, POST, PATCH, DELETE
- [ ] Add archive functionality

## Phase 3: Time Tracking Core

### 3.1 Entry Bar Component
- [ ] Create `components/entry/entry-bar.tsx`
- [ ] Implement quick search with Command component
- [ ] Add keyboard navigation (↓/↑, Enter, Tab, Escape)
- [ ] Duration input with rounding
- [ ] Date picker (defaults to today)
- [ ] Billable toggle with $ hotkey
- [ ] Cmd/Ctrl+Enter to save from anywhere

### 3.2 Suggestions API
- [ ] Create `app/api/v1/organizations/[orgId]/suggestions/route.ts`
- [ ] Implement recent usage ranking
- [ ] Add time-of-week pattern matching (Redis for caching)
- [ ] Return ranked results with reason

### 3.3 Time Entries API
- [ ] Create `app/api/v1/organizations/[orgId]/entries/route.ts`
- [ ] Implement GET with date range, client, project filters
- [ ] Implement POST (single and batch)
- [ ] Implement PATCH for updates
- [ ] Implement DELETE

### 3.4 Timeline View
- [ ] Create `app/(app)/track/page.tsx`
- [ ] Implement day grouping with daily totals
- [ ] Week navigation (◀ Week of Jan 27 ▶)
- [ ] Today total and week total display
- [ ] Entry row component with inline editing
- [ ] Click to edit: description, project/task, duration, billable
- [ ] Drag between days to change date
- [ ] Delete and duplicate actions on hover

## Phase 4: Reports

### 4.1 Report Config Management
- [ ] Create `app/(app)/reports/page.tsx`
- [ ] List report configs (client and project level)
- [ ] Edit config: enabled, show rates, auto-send settings
- [ ] Manage recipients

### 4.2 Public Report Pages
- [ ] Create `app/(public)/r/[slug]/page.tsx`
- [ ] Create `app/(public)/r/[slug]/[projectSlug]/page.tsx`
- [ ] Date range selector (default: current week)
- [ ] Week/month navigation
- [ ] Entries grouped by day or by project (toggle)
- [ ] Hours and billable amount totals
- [ ] Print-friendly styling

### 4.3 CSV Export
- [ ] Create `app/api/v1/organizations/[orgId]/entries/export/route.ts`
- [ ] Support date range parameters
- [ ] Format: date, client, project, task, description, hours, billable

## Phase 5: Email

### 5.1 Email Templates
- [ ] Create `lib/email/templates/weekly-report.tsx` with React Email
- [ ] Include key stats: total hours, billable hours, top projects
- [ ] "View full report" CTA button

### 5.2 Manual Send
- [ ] Add "Send Report" button in report management
- [ ] Send to configured recipients via Resend

### 5.3 Auto-send Scheduling
- [ ] Create cron endpoint or use Vercel cron
- [ ] Query report configs with auto_send enabled
- [ ] Send based on auto_send_day and auto_send_hour

## Phase 6: Polish

### 6.1 Rate Resolution
- [ ] Implement `resolveRate(taskId)` helper
- [ ] Walk up tree: Task → Project → Client → Org
- [ ] Same for `resolveBillable(taskId)`

### 6.2 Smart Suggestions Enhancement
- [ ] Track usage patterns in Redis
- [ ] Day-of-week correlations
- [ ] Time-of-day patterns
- [ ] Improve ranking algorithm

### 6.3 Keyboard Shortcuts
- [ ] Global shortcuts documentation
- [ ] `/` to focus entry bar
- [ ] `n` for new entry
- [ ] Ensure full keyboard navigability

## Out of Scope (Phase 4 - SaaS Prep)

These are documented but not part of initial implementation:
- Plan/limits infrastructure
- Usage tracking
- Stripe billing integration
- Landing page / marketing site

---

## Getting Started

```bash
# Start database
docker compose up -d

# Push schema
pnpm db:push

# Run dev server
pnpm dev
```

## Notes

- All API routes return JSON
- All authenticated routes require valid session
- Organization ID comes from session context, never user input for writes
- Use Server Actions where appropriate, but maintain REST API for data liberation
- **Event-driven over polling** - Use Redis pub/sub or SSE for real-time updates (e.g., timeline updates when another team member logs time). Avoid polling.
