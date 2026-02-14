# My Work Dashboard & Inbox Hierarchy Design

> **Status:** Phase 1 (Foundation) and Phase 2 (Dashboard) complete. Phase 3 (Inbox Hierarchy) pending.
> See `docs/plans/2026-02-14-my-work-command-center.md` for the command center redesign plan.

## Summary

Replace `/track` as the default landing page with a personal command center ("My Work") that surfaces everything needing attention across all entities. Formalize the inbox hierarchy so items trickle up from project → client → org. Add entity ownership (clients, projects) to drive automatic routing. Connect it all so your dashboard answers "what needs my attention?" without manual setup.

### What's built (as of 2026-02-14)

**Phase 1 — Foundation:**
- Entity ownership (`assignedTo`) on clients, projects, tasks, inbox items
- Assignment inheritance resolver (`lib/assignment.ts`)
- Default assignee org setting with UI in settings form
- Ownership selectors on client/project edit forms
- Due date picker on task edit form
- Single-user auto-assign on org creation
- Second-member nudge trigger and banner
- Bulk reassignment API and UI on team page

**Phase 2 — Command Center Dashboard:**
- Time-grouped feed: Overdue → Today → This Week → Upcoming → Needs Attention
- All entity types: tasks, invoices, proposals, contracts, expenses, inbox items, calendar events
- Expanded summary with money stats (unbilled hours, outstanding invoices, pending expenses)
- Calendar integration via ICS feed (per-user setting on profile page)
- Auto-refresh polling, deep-linking, empty states

**Phase 3 — Inbox Hierarchy (pending):**
- Client/project scoped inbox views
- Inbox reassignment between scopes
- Inbox count badges on entity dashboards

## Core Concepts

### Entity Ownership & Default Assignment

Projects and clients get an `assignedTo` field — the person primarily responsible. This drives routing for the My Work dashboard: inbox items, tasks, and invoices for entities you own show up in your feed automatically.

**Inheritance chain (top-down defaults):**
```
Org default assignee (org setting)
  └→ Client.assignedTo (inherits org default if not set)
      └→ Project.assignedTo (inherits client owner if not set)
          └→ Task.assignedTo (inherits project owner if not set)
              └→ Inbox item routing (follows entity ownership)
```

When creating a new entity, `assignedTo` auto-fills from the parent unless explicitly set. This is a default, not a constraint — you can always override.

**Single-user teams:** The org has one member, so the org default assignee is that person. Everything flows down automatically — no manual assignment ever needed. New client? Assigned to you. New project under that client? Assigned to you. New task? Assigned to you. Inbox item arrives? It's yours.

**Multi-user teams:** The org setting can have a default assignee (or not). Clients and projects get explicitly assigned to team members. Tasks within a project default to the project owner but can be reassigned.

**Second member nudge:** When a single-user org adds their second team member, surface a notification: "Everything is currently assigned to you. You can update default assignments in Settings or on individual clients and projects." Not blocking — just informational, handle it when convenient.

**What "ownership" means for My Work:**
- Inbox item arrives at a project I own → appears in my "Needs Triage"
- Invoice for a client I own → appears in my "Ready to Send" when approved
- Task in my project with no explicit assignee → appears in my "My Items"
- Task explicitly assigned to someone else → appears in their dashboard, not mine

**Team member removal / bulk reassignment:**
When someone leaves or workload needs redistributing, provide a bulk reassignment action:
- Select a user → see all their assigned entities grouped by type
- Pick which entity types to reassign (tasks, projects, clients — independently)
- Choose a new assignee or unassign
- Does not cascade — reassigning a project doesn't touch its tasks. Each type is handled separately.

### My Work Dashboard

A person-centric view that answers: "What needs my attention right now?"

The standard time entry bar remains at the top of the page, same as every other page. Below it is the dashboard content.

**Structure:**
```
┌──────────────────────────────────────────────────┐
│  [Standard time entry bar — same as every page]  │
├──────────────────────────────────────────────────┤
│                                                  │
│  Today: 5h 20m tracked · 2 tasks completed       │
│  This week: 28h · 8 completed · 12 remaining     │
│  4 items due this week · ~18h estimated work      │
│                                                  │
├──────────────────────────────────────────────────┤
│                                                  │
│  ⚠ Past Due (3)           📅 Due Soon (5)        │
│  ├─ Task: Fix login bug    ├─ Task: Deploy v2    │
│  ├─ Invoice: INV-2024-12   ├─ Task: Review PR    │
│  └─ Task: Update docs      └─ ...                │
│                                                  │
│  📥 Needs Triage (2)       🚫 Blocked (1)        │
│  ├─ Inbox: receipt.pdf     ├─ Task: API refactor │
│  └─ Inbox: contract.pdf   │                      │
│                                                  │
│  📋 My Items                                     │
│  ├─ Task: Build dashboard  (in_progress)         │
│  ├─ Task: Write tests      (todo)                │
│  └─ ...                                          │
│                                                  │
│  👤 Unassigned                                   │
│  ├─ Task: Triage bug report                      │
│  └─ Inbox: forwarded invoice                     │
│                                                  │
│  📊 Recent Activity                              │
│  ├─ You completed "Fix auth" · 2h ago            │
│  ├─ Contract "Acme Q1" expiring in 5 days        │
│  ├─ You commented on "API spec" · 3h ago         │
│  └─ Proposal "Redesign" awaiting response        │
│                                                  │
└──────────────────────────────────────────────────┘
```

**Workload summary (top of dashboard):**
Light, informational stats — not a performance tracker:
- Today: time tracked, tasks completed
- This week: time tracked, tasks completed, tasks remaining
- Upcoming: items due this week, estimated work remaining
- Tone: observational, not pressure-y. "Here's what your week looks like."

**Sections (in priority order):**

| Section | Source | Filter |
|---------|--------|--------|
| Past Due | Tasks, Invoices | `dueDate < now`, assigned to me, `status` not done/paid/voided, exclude `isAutoGenerated` drafts |
| Due Soon | Tasks, Invoices | `dueDate` within next 7 days, same exclusions |
| Needs Triage | Inbox items | `status = needs_review`, assigned to me or unassigned in my scope |
| Blocked | Tasks | Assigned to me, has unresolved `blocked_by` relationship |
| My Items | Tasks, Inbox items | Assigned to me, not in above sections |
| Unassigned | Tasks, Inbox items | No `assignedTo`, visible to me (see visibility rules below) |
| Recent Activity | Activities, Proposals, Contracts | Mixed timeline of actions + informational items |

**Unassigned visibility:** Everyone in the org sees unassigned items within their scope — projects they're a member of, clients they own, or items with no entity context. Anyone can "claim" an item (assign it to themselves). For small teams this is collaborative and lightweight. If teams grow, scope it down to admin-only or member-scoped.

**Informational items in the activity feed:**
Proposals awaiting response, contracts nearing expiration, and similar status-based items appear as lightweight entries in the activity timeline. They're clickable (jump to the entity) but visually minimal — like activity items in discussion panels. Not prominent enough to demand action, but present enough to keep you aware.

**Auto-generated invoice drafts:** Excluded from Past Due / Due Soon unless the invoice has been manually finalized (sent, or explicitly approved). Rolling auto-drafts are system-managed and shouldn't create dashboard noise.

**Calendar integration (future):** If a calendar is connected, show today's meetings/events as context. "Meeting with Acme Corp in 1 hour — 3 open tasks for them." Not in initial build.

### Inbox Hierarchy

The inbox already exists (`inbox_items` table, conversion endpoints, intake emails at org/client/project levels). What's missing is the trickle-up visibility.

**Current state:**
- `/inbox` page exists, shows all org items
- API supports filtering by status
- Conversion to expense, file, task, discussion already works
- Intake tokens on orgs, clients, projects

**What changes:**

1. **Client inbox view** — shows items where `clientId = X` (includes that client's project items)
2. **Project inbox view** — shows items where `projectId = X`
3. **Org inbox view** — shows everything (current behavior, already works)
4. **Reassignment** — move an item from org level down to a client, or from client to a specific project
5. **Intake email on client dashboard** — `IntakeEmailPopover` already supports clients in the API, just needs UI placement

**Inbox on entity dashboards:**
- Project dashboard: show inbox count badge, quick-access to project inbox items
- Client dashboard: show inbox count badge, items for that client + its projects
- Org-level inbox page: the full triage view (already exists at `/inbox`)

**Inbox item scope for "Needs Triage" routing:**
Follows the ownership chain. If a project has an owner, items go to them. If not, falls back to the client owner, then org default. This mirrors the assignment inheritance — most specific owner wins.

**Auto-categorization (future iteration):**
- PDF with dollar amounts → suggest expense
- Known sender email → auto-assign to client
- Pattern matching on subjects ("Invoice", "Receipt") → suggest expense

### Activity Feed

Uses the existing `activities` table which already tracks:
- Entity type (task, project, expense, invoice, document, time_entry, contact)
- Action (created, updated, status_changed, assigned, commented, file_attached, etc.)
- Actor (who did it)
- Field-level diffs (old/new values)

**Dashboard usage:** Filter by `actorId = currentUser`, sorted by `createdAt desc`, last 7 days. Group by day. Show human-readable summaries like "Completed task 'Fix auth bug'" or "Commented on 'API spec'".

**Informational items mixed in:** Proposals, contracts, and other status-based entities appear inline with activity items. They're not actions you took — they're things to be aware of. Visual treatment is lighter (like discussion activity items), clickable to navigate.

**Team view (admin/manager):** Same feed but filtered by a specific team member, or unfiltered to see all org activity.

## Schema Changes

### Clients: add `assignedTo`

```sql
ALTER TABLE clients ADD COLUMN assigned_to text REFERENCES "user" (id) ON DELETE SET NULL;
```

The person responsible for this client. Drives default assignment for new projects under this client and routes inbox items / invoices to the owner's dashboard.

### Projects: add `assignedTo`

```sql
ALTER TABLE projects ADD COLUMN assigned_to text REFERENCES "user" (id) ON DELETE SET NULL;
```

The person responsible for this project. Drives default assignment for new tasks and routes inbox items to the owner's dashboard. Falls back to the parent client's `assignedTo` if not set.

Note: `projectMembers` already exists for access control — `assignedTo` is different. Members can see/edit the project; the owner is primarily responsible for it.

### Tasks: add `dueDate`

```sql
ALTER TABLE tasks ADD COLUMN due_date date;
CREATE INDEX tasks_due_date_idx ON tasks (due_date) WHERE due_date IS NOT NULL;
```

### Inbox items: add `assignedTo`

```sql
ALTER TABLE inbox_items ADD COLUMN assigned_to text REFERENCES "user" (id) ON DELETE SET NULL;
```

Allows inbox items to be assigned to a specific person for triage. Auto-populated from entity ownership: if an item arrives at a project with an owner, it gets assigned to that person.

### Org settings: add `defaultAssignee`

Add to the org `settings` JSON (or `features` JSON — whichever holds org-level config):

```json
{ "defaultAssignee": "user_id_here" }
```

For single-user teams, this is set automatically when the org is created. For multi-user teams, optional — an admin can set it in org settings.

### Assignment inheritance logic (server-side)

When creating an entity, resolve `assignedTo` if not explicitly provided:

```
Task.assignedTo     ← explicit || Project.assignedTo || Client.assignedTo || Org.defaultAssignee
Project.assignedTo  ← explicit || Client.assignedTo || Org.defaultAssignee
Client.assignedTo   ← explicit || Org.defaultAssignee
InboxItem.assignedTo ← explicit || Project.assignedTo || Client.assignedTo || Org.defaultAssignee
```

This is resolved at creation time (not a runtime lookup). If ownership changes upstream, existing children keep their current assignment — only new entities pick up the new default.

## API Endpoints

### My Work Dashboard

```
GET /api/v1/organizations/{orgId}/my-work
```

Returns a unified payload:

```json
{
  "summary": {
    "today": { "minutesTracked": 320, "tasksCompleted": 2 },
    "thisWeek": { "minutesTracked": 1680, "tasksCompleted": 8, "tasksRemaining": 12 },
    "upcoming": { "itemsDueThisWeek": 4, "estimatedMinutes": 1080 }
  },
  "pastDue": [...],
  "dueSoon": [...],
  "needsTriage": [...],
  "blocked": [...],
  "myItems": [...],
  "unassigned": [...],
  "recentActivity": [...]
}
```

Each section contains items with a common shape:
```json
{
  "type": "task" | "inbox_item" | "invoice" | "proposal" | "contract",
  "id": "...",
  "title": "...",
  "dueDate": "2026-02-15" | null,
  "status": "...",
  "priority": "high" | null,
  "project": { "id": "...", "name": "...", "client": { ... } } | null,
  "isInformational": false
}
```

`isInformational: true` for proposal/contract status items that appear in the activity feed.

Single endpoint keeps the dashboard fast (one request, server does the aggregation).

### Inbox Reassignment

```
POST /api/v1/organizations/{orgId}/inbox/{itemId}/reassign
Body: { "clientId": "...", "projectId": "..." }
```

Moves an inbox item to a more specific scope.

### Bulk Reassignment

```
POST /api/v1/organizations/{orgId}/members/{userId}/reassign
Body: {
  "newAssignee": "user_id" | null,
  "entityTypes": ["tasks", "projects", "clients"]
}
```

Reassigns (or unassigns) all entities of the specified types from one user to another. Each entity type is independent — you can reassign tasks without touching projects.

## Navigation Changes

```
Before:                    After:
─────────                  ─────────
Track                      My Work ← new default
─────────                  Track
Clients                    ─────────
Projects                   Clients
Tasks                      Projects
─────────                  Tasks
Invoices                   ─────────
Expenses                   Invoices
Proposals                  Expenses
Contracts                  Proposals
─────────                  Contracts
Inbox                      ─────────
Reports                    Inbox
                           Reports
```

`/track` remains for time entry. My Work becomes the landing page. Inbox stays in its current position — the dashboard surfaces inbox items that need your attention, but the full triage view remains at `/inbox`.

## UI Components

### Dashboard Sections

Each section is a collapsible card with a count badge. Items within are compact rows (similar to list view in tasks-content.tsx):
- Entity type icon
- Title
- Project/client context (dot + name)
- Due date (if applicable, with urgency coloring)
- Status badge
- Click to open detail modal

Informational items (proposals, contracts) use lighter styling — no status badge, muted text, similar to activity items in discussion panels. Clickable to navigate.

### Workload Summary

Compact stat line at the top of the dashboard content:
```
Today: 5h 20m tracked · 2 tasks completed
This week: 28h · 8 completed · 12 remaining
4 items due this week · ~18h estimated work
```

Simple text, no charts or gauges. Observational tone.

### Inbox on Entity Dashboards

Small card or section showing count + recent items:
```
Inbox (3 items)
├─ receipt-march.pdf · 2 hours ago
├─ contract-v2.pdf · yesterday
└─ View all →
```

### Ownership Selector

Reuse the existing member/user selector pattern (Popover + Command) on client and project edit forms. Shows org members, allows clearing (unassigned).

## Edge Cases

### Completed items with past-due dates
Tasks with `status = done` or invoices with `status = paid/voided` are excluded from Past Due / Due Soon, even if `dueDate` is in the past.

### Auto-generated invoice drafts
Excluded from dashboard sections unless manually finalized (`sentAt` is set or status is not `draft`). Rolling auto-drafts are background bookkeeping.

### Inbox item scope resolution
When an inbox item arrives, routing follows the ownership chain: project owner → client owner → org default assignee. If none are set, the item is unassigned and appears in everyone's "Unassigned" section.

### Team member removed
FK `ON DELETE SET NULL` orphans their assignments. The "Unassigned" section catches these organically. Bulk reassignment is available proactively.

### Single-user org adds second member
Surface a non-blocking notification explaining that everything is currently assigned to them and where to update defaults. No automatic changes.

## Implementation Order

### Phase 1: Foundation
1. **Schema migration** — add `assignedTo` to clients and projects, `dueDate` to tasks, `assignedTo` to inbox_items, `defaultAssignee` to org settings
2. **Assignment inheritance** — server-side logic to resolve `assignedTo` defaults on entity creation
3. **Ownership UI** — assignee selector on client/project edit forms, org settings for default assignee
4. **Single-user auto-assign** — detect single-member orgs and auto-set `defaultAssignee`
5. **Bulk reassignment** — admin action to reassign entities by type

### Phase 2: My Work Dashboard
6. **My Work API** — single aggregation endpoint with summary stats
7. **My Work page** — new route at `/work` or root `/`
8. **Workload summary** — stat line at top
9. **Dashboard sections** — past due, due soon, needs triage, blocked, my items, unassigned
10. **Activity feed section** — recent activity + informational items timeline
11. **Nav update** — add My Work as first item, make it the default

### Phase 3: Inbox Hierarchy
12. **Inbox hierarchy queries** — client/project scoped views with trickle-up
13. **Inbox reassignment** — move items between scopes
14. **Inbox on entity dashboards** — count badges and inline previews

### Future
15. **Auto-categorization** — suggest expense/file/task based on content
16. **Calendar integration** — surface calendar context on dashboard
17. **Team activity view** — admin view of all org activity filtered by member
