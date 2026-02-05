# Platform Expansion Plan

Expanding the time tracking app into a complete freelancer business platform.

## Philosophy

**Built for me first.** This is a tool that supports my opinionated way of working. If it resonates with others, great - but that's secondary. The goal is to replace multiple tools (Toggl, Basecamp, invoicing apps, contract tools) with one integrated system that works exactly how I want.

**One tool for the full freelance lifecycle:**
```
Lead → Proposal → Contract → Project → Tasks → Time → Invoice → Payment
```

**Core principles:**
- **Opinionated simplicity** - Fixed stages, fixed statuses, no custom workflows. The tool has opinions.
- **Built for power users** - Keyboard-first, fast, no hand-holding
- **Clean client experience** - Clients see exactly what you want them to see, nothing more
- **AI as a tool, not a feature** - AI helps where useful (polishing text, suggestions), but isn't the headline
- **Self-hostable** - Runs on your own infrastructure (Dokploy on Hetzner VPS)

**What this is NOT:**
- A platform to sell to enterprises
- A "customizable workflow engine"
- AI-first/AI-powered marketing fodder

---

## Architecture Decisions

### Hosting
- **Platform:** Dokploy on Hetzner VPS (self-hosted Docker deployment)
- **Database:** PostgreSQL
- **Cache:** Redis
- **File Storage:** Cloudflare R2

### Navigation Structure
Documents, expenses, and other entities exist at both project and org level. Top-level nav provides org-wide views:

```
Sidebar:
├── Track (time entry)
├── Projects
├── Clients
├── Proposals (all proposals across projects)
├── Contracts (all contracts across projects)
├── Expenses (all expenses across projects)
├── Invoices
├── Reports
└── Settings
```

Each top-level view shows org-wide data with filtering by client/project. Same data, different entry points.

### Payment Providers
Supporting multiple providers through abstraction:

| Provider | Use Case | Status |
|----------|----------|--------|
| **Stripe** | Client invoice payments, payment links | Planned |
| **Polar** | SaaS subscriptions (if productized) | Future |

Build abstraction layer that supports both. Start with Stripe for invoice payments (client-facing). Add Polar later if the tool becomes a product others pay for.

### Security ✅ IMPLEMENTED

**Rate limiting** (`lib/security.ts`):
- [x] Redis-backed rate limiting for public endpoints
- [x] IP-based rate limits (10 requests/min for token lookups, 5 requests/min for form submissions)
- [x] Graceful fallback when Redis unavailable

**Token validation**:
- [x] 32-character nanoid tokens for public document links
- [x] Strict validation before database lookup (prevent timing attacks)
- [x] Token format: alphanumeric only

**Security event logging**:
- [x] Audit trail for suspicious activity
- [x] Logged events: invalid tokens, rate limit exceeded, successful document views/accepts
- [x] Includes IP, user agent, referer, timestamp

**Access control**:
- [ ] Disable public signups (admin-controlled) - Future

---

## Feature Modules

| Module | Description | Toggle |
|--------|-------------|--------|
| **Core** | Clients, Projects (with stages) | Always on |
| **Time Tracking** | Entries, timeline, reports | Optional |
| **Invoicing** | Billing config, invoice generation, payment tracking | Optional |
| **PM** | Task statuses, kanban board, client portal | Optional |
| **Proposals & Contracts** | Document builder, AI review, acceptance flow | Optional |

---

## Implementation Phases

### Phase 1: Foundation ✅ COMPLETE

- [x] Feature flags infrastructure (`features` JSONB on organizations)
- [x] Update onboarding to ask what features needed
- [x] Conditional navigation based on features
- [x] Project stages field (`lead`, `proposal_sent`, `active`, `completed`)
- [x] Project budget fields (`budgetType`, `budgetHours`, `budgetAmountCents`)
- [x] Stage badges and filters in projects list
- [x] Stage selector in project dialog

### Phase 2: Unified Tasks ✅ COMPLETE

Tasks serve dual purpose: time tracking categories AND PM work items.

**Schema Changes:**
```sql
ALTER TABLE tasks ADD COLUMN description TEXT;
ALTER TABLE tasks ADD COLUMN status TEXT;
-- Values: null (category-only), 'todo', 'in_progress', 'review', 'done'

ALTER TABLE tasks ADD COLUMN is_recurring BOOLEAN DEFAULT false;
-- true = category-style, always shows in time entry dropdown

ALTER TABLE tasks ADD COLUMN assigned_to UUID REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN created_by UUID REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN position INTEGER;
-- For kanban board ordering
```

**UI:**
- [x] Task list view with status badges
- [x] Status filter dropdown
- [x] Kanban board view (when PM enabled)
- [x] Drag-and-drop to change status
- [x] Time entry works with both category and work-item tasks

**Files created:**
- `components/projects/task-list.tsx` - Task list with filtering and grouping
- `components/projects/kanban-board.tsx` - Drag-and-drop kanban board
- `components/projects/task-dialog.tsx` - Updated with PM fields (status, description)

### Phase 3: Client Portal ✅ COMPLETE

**Schema:**
```sql
CREATE TABLE project_invitations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer', -- 'viewer', 'contributor'
  visibility JSONB DEFAULT '{"show_rates": false, "show_time": true, "show_costs": false}',
  invited_by UUID REFERENCES users(id),
  token TEXT NOT NULL UNIQUE, -- Magic link token
  sent_at TIMESTAMP,
  viewed_at TIMESTAMP,
  accepted_at TIMESTAMP,
  user_id UUID REFERENCES users(id), -- Set when accepted
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(project_id, email)
);
```

**UI:**
- [x] Project → Settings → Invite Client (ProjectInvitations component)
- [x] Magic link auth for clients (`/invite/[token]` accept flow)
- [x] Portal dashboard (`/portal` - list of invited projects)
- [x] Project view (`/portal/[projectId]` - progress, tasks, stats)
- [x] Role-based permissions (viewer vs contributor)

**API Endpoints:**
- `GET/POST /api/v1/organizations/[orgId]/projects/[projectId]/invitations`
- `GET/PATCH/DELETE /api/v1/organizations/[orgId]/projects/[projectId]/invitations/[invitationId]`
- `GET/POST /api/invitations/[token]` - Public invitation accept
- `GET /api/portal/projects` - List user's invited projects
- `GET /api/portal/projects/[projectId]` - Project detail for portal

**Files created:**
- `app/(portal)/layout.tsx` - Portal layout
- `app/(portal)/portal/page.tsx` - Client dashboard
- `app/(portal)/portal/[projectId]/page.tsx` - Project detail view
- `app/(public)/invite/[token]/page.tsx` - Invitation accept flow
- `components/projects/project-invitations.tsx` - Invitation management UI

### Phase 4: Files (R2 Storage) ✅ COMPLETE

**Schema:**
```sql
CREATE TABLE project_files (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  uploaded_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  tags JSONB DEFAULT '[]',
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Implementation:**
- [x] R2 integration setup (`lib/r2.ts` with S3-compatible client)
- [x] Presigned URLs for uploads (client-side direct upload)
- [x] Presigned URLs for downloads (time-limited access)
- [x] Organize by: `/{org_id}/{project_id}/{file_id}/{filename}`
- [x] Upload UI with drag-and-drop
- [x] Tagging system with filter UI

**Files created:**
- `lib/r2.ts` - R2 client with presigned URL generation
- `components/projects/project-files.tsx` - File upload UI with drag-and-drop
- `app/api/v1/organizations/[orgId]/projects/[projectId]/files/route.ts` - List/create files
- `app/api/v1/organizations/[orgId]/projects/[projectId]/files/[fileId]/route.ts` - Get/update/delete files

**Environment variables required:**
- `R2_ENDPOINT` - Cloudflare R2 endpoint URL
- `R2_ACCESS_KEY_ID` - R2 access key
- `R2_SECRET_ACCESS_KEY` - R2 secret key
- `R2_BUCKET_NAME` - R2 bucket name

### Phase 5: Activity Log ✅ COMPLETE

**Schema:**
```sql
CREATE TABLE project_activities (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL,
  -- Types: 'note', 'stage_change', 'task_created', 'task_status_changed', 'task_completed',
  -- 'file_uploaded', 'file_deleted', 'invitation_sent', 'invitation_accepted',
  -- 'invoice_created', 'invoice_sent', 'document_sent', 'document_accepted'
  actor_id TEXT REFERENCES users(id), -- null for system events
  actor_type TEXT DEFAULT 'user', -- 'user', 'client', 'system'
  content TEXT, -- For notes: text content
  metadata JSONB, -- Event-specific data
  is_public BOOLEAN DEFAULT false, -- Whether visible to clients
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Implementation:**
- [x] Activity table schema with typed metadata
- [x] Activity API endpoints (list, create notes, update, delete)
- [x] Activity timeline component (`ProjectActivity`)
- [x] Manual notes with public/internal visibility toggle
- [x] Edit and delete notes
- [x] Automatic logging helper functions (`lib/activity.ts`)
- [x] Automatic logging for file uploads and deletions
- [x] Automatic logging for invitation sent and accepted
- [x] Activity section on project dashboard

**Files created:**
- `lib/activity.ts` - Helper functions for logging activities
- `components/projects/project-activity.tsx` - Activity timeline UI
- `app/api/v1/organizations/[orgId]/projects/[projectId]/activities/route.ts` - List/create activities
- `app/api/v1/organizations/[orgId]/projects/[projectId]/activities/[activityId]/route.ts` - Update/delete notes

### Phase 6: Documents (Proposals & Contracts) ✅ COMPLETE

**Schema:**
```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL, -- 'proposal', 'contract'
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'sent', 'viewed', 'accepted', 'declined'
  title TEXT NOT NULL,
  content JSONB NOT NULL, -- Structured sections with pricing
  requires_contract BOOLEAN DEFAULT false, -- For proposals
  public_token TEXT UNIQUE, -- For client viewing/accepting
  sent_at TIMESTAMP,
  viewed_at TIMESTAMP,
  accepted_at TIMESTAMP,
  declined_at TIMESTAMP,
  accepted_by TEXT, -- Email of person who accepted
  declined_by TEXT,
  decline_reason TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Implementation:**
- [x] Documents table schema with typed content structure
- [x] Documents API endpoints (list, create, update, delete, send)
- [x] Public document API for viewing and accepting/declining
- [x] Document builder UI with structured sections
- [x] Section management (add, remove, reorder)
- [x] Public document view page (`/d/[token]`)
- [x] Accept/decline flow with email capture
- [x] Documents section on project dashboard
- [x] Activity logging for document sent/accepted

**Files created:**
- `components/documents/document-editor.tsx` - Document editor with sections
- `components/projects/project-documents.tsx` - Documents list for projects
- `app/(app)/projects/[id]/documents/[documentId]/page.tsx` - Document editor page
- `app/(public)/d/[token]/page.tsx` - Public document view
- `app/api/v1/organizations/[orgId]/projects/[projectId]/documents/route.ts` - List/create
- `app/api/v1/organizations/[orgId]/projects/[projectId]/documents/[documentId]/route.ts` - CRUD
- `app/api/v1/organizations/[orgId]/projects/[projectId]/documents/[documentId]/send/route.ts` - Send
- `app/api/documents/[token]/route.ts` - Public accept/decline

**Deferred to later:**
- AI review integration (polish language) - Future enhancement
- Template save/load - Future enhancement
- Contract generation from accepted proposal - Future enhancement

### Phase 7: Financial Tracking ✅ COMPLETE

**Schema:**
```sql
CREATE TABLE project_expenses (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID REFERENCES projects(id), -- NULL = overhead/general business expense
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  date DATE NOT NULL,
  category TEXT,
  receipt_file_id UUID REFERENCES project_files(id),
  is_billable BOOLEAN DEFAULT false,
  -- Source tracking (for imports)
  source TEXT DEFAULT 'manual', -- 'manual', 'plaid', 'email', 'paperless'
  external_id TEXT, -- Plaid transaction ID, email message ID, etc.
  -- Recurring expense support
  is_recurring BOOLEAN DEFAULT false,
  recurring_frequency TEXT, -- 'weekly', 'monthly', 'quarterly', 'yearly'
  next_occurrence DATE, -- When to generate next expense (for cron)
  recurring_end_date DATE, -- Optional: when to stop recurring
  parent_expense_id UUID, -- Links generated expenses to the recurring template
  -- Tracking
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Implementation:**
- [x] Expenses table schema with category field
- [x] Organization-level expenses (not just project-scoped)
- [x] Optional project assignment (overhead/general business expenses)
- [x] Recurring expense support (weekly, monthly, quarterly, yearly)
- [x] Source tracking for imports (manual, plaid, email, paperless)
- [x] Expenses API endpoints (list, create, update, delete)
- [x] Expense entry UI with add/edit dialogs
- [x] Category selection with defaults
- [x] Billable toggle
- [x] Summary stats (total, billable, non-billable, overhead)
- [x] Expenses section on project dashboard

**Files created:**
- `components/projects/project-expenses.tsx` - Expense list and management UI
- `app/api/v1/organizations/[orgId]/projects/[projectId]/expenses/route.ts` - Project-scoped list/create
- `app/api/v1/organizations/[orgId]/projects/[projectId]/expenses/[expenseId]/route.ts` - CRUD
- `app/api/v1/organizations/[orgId]/expenses/route.ts` - Org-wide expenses API
- `app/(app)/expenses/expense-dialog.tsx` - Expense creation dialog with recurring support

**Pending:**
- [ ] Cron job to auto-generate recurring expenses

**Deferred to later:**
- Receipt file attachment (UI for linking files) - Future enhancement
- Budget vs actual dashboard widget - Future enhancement
- Project profitability view - Future enhancement

### Phase 8: Top-Level Navigation Views ✅ COMPLETE

Add org-wide views for documents, expenses, etc. Same data, different entry points.

**Implementation:**
- [x] `/proposals` - All proposals across projects, with status filters
- [x] `/contracts` - All contracts across projects
- [x] `/expenses` - All expenses across projects, with category/billable filters

**API endpoints:**
- [x] `GET /api/v1/organizations/[orgId]/documents` - All docs with type/status/client/project filters
- [x] `GET /api/v1/organizations/[orgId]/expenses` - All expenses with date/category/billable filters

**Navigation updates:**
- [x] Added Proposals, Contracts, Expenses to sidebar nav
- [x] Proposals and Contracts require `proposals` feature flag
- [x] Expenses always visible (core financial feature)

**Files created:**
- `app/(app)/proposals/page.tsx` + `proposals-content.tsx` - Org-wide proposals view
- `app/(app)/contracts/page.tsx` + `contracts-content.tsx` - Org-wide contracts view
- `app/(app)/expenses/page.tsx` + `expenses-content.tsx` - Org-wide expenses view
- `app/(app)/expenses/expense-dialog.tsx` - New expense dialog with recurring support
- `components/documents/new-document-dialog.tsx` - New proposal/contract dialog
- `app/api/v1/organizations/[orgId]/documents/route.ts` - Org-wide documents API
- `app/api/v1/organizations/[orgId]/expenses/route.ts` - Org-wide expenses API (GET + POST)

**Create buttons:**
- [x] "New Expense" on `/expenses` - with project picker (optional), recurring support
- [x] "New Proposal" on `/proposals` - with project picker
- [x] "New Contract" on `/contracts` - with project picker

**Deferred:**
- `/estimates` page - Would add estimate type to documents if needed

### Phase 9: Payment Provider Integration ✅ FOUNDATION COMPLETE

**Architecture:**
- [x] Payment provider type definitions (`lib/payments/types.ts`)
- [x] Support for multiple providers (Stripe now, Polar later)
- [x] Payment settings UI in organization settings
- [x] No API keys configured until ready to enable

**Files created:**
- `lib/payments/types.ts` - Type definitions for Stripe and Polar
- `app/(app)/settings/payment-settings.tsx` - Payment provider settings UI

**Stripe Integration (pending keys):**
- [ ] Stripe client setup (no keys yet)
- [ ] OAuth connection flow
- [ ] Payment link generation for invoices
- [ ] Webhook handler for payment confirmation
- [ ] Invoice status updates on payment

**Polar Integration (Future):**
- [ ] For SaaS subscriptions if tool is productized
- [ ] Simpler than Stripe for subscription management

**Note:** Keys not added until payments are enabled. UI shows "Coming Soon" badge.

### Phase 10: Expense Import Integrations

Automatic expense capture from multiple sources, all feeding into a central inbox for review.

**Import Sources:**

| Source | What it captures | Status |
|--------|------------------|--------|
| **Plaid** | Bank/card transactions | Planned |
| **Paperless-ngx** | Scanned receipts (OCR) | Planned |
| **Email** | Forwarded receipts | Planned |
| **Manual** | Direct entry | ✅ Done |

**Architecture:**
```
Plaid API ─────────┐
                   │
Paperless webhook ─┼──→ Expense Inbox ──→ Review/Categorize ──→ Expenses
                   │
Email parser ──────┘
```

**Expense Inbox Features:**
- [ ] Unmatched expenses from all sources
- [ ] Quick assign to project (or mark as overhead)
- [ ] Category assignment with autocomplete
- [ ] Rules engine: "vendor contains 'Figma' → Software category"
- [ ] Rules auto-apply to future imports

**Plaid Integration:**
- [ ] Plaid Link for bank account connection
- [ ] Transaction sync (daily or webhook)
- [ ] Vendor name extraction
- [ ] Duplicate detection

**Paperless-ngx Integration:**
- [ ] Webhook receiver for new documents
- [ ] Extract amount, vendor, date from OCR
- [ ] Link receipt file to expense

**Implementation:**
- [ ] `lib/integrations/plaid.ts` - Plaid client
- [ ] `lib/integrations/paperless.ts` - Paperless API client
- [ ] `app/api/webhooks/paperless/route.ts` - Webhook receiver
- [ ] `app/(app)/expenses/inbox/page.tsx` - Expense inbox UI
- [ ] `lib/db/schema.ts` - Add expense_rules table

### Phase 11: Email Forwarding

**Implementation:**
- [ ] Inbound email setup (Resend or dedicated service)
- [ ] Email parsing + activity creation
- [ ] Attachment extraction to R2
- [ ] Unique email address per project

### Phase 11: Polish

- [ ] Markdown editor with WYSIWYG option (Tiptap)
- [ ] Mobile-responsive portal
- [ ] Notification preferences
- [ ] Email templates for all flows
- [ ] Disable public signups (admin-controlled)

### Phase 11: External Integrations (Basecamp, ClickUp, Asana)

**Goal:** Single source of truth. Changes in external systems appear here; changes here sync back.

**Schema:**
```sql
CREATE TABLE integrations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL, -- 'basecamp', 'clickup', 'asana', 'linear', 'notion'
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'paused', 'error'
  credentials JSONB NOT NULL, -- Encrypted OAuth tokens
  settings JSONB DEFAULT '{}', -- Provider-specific settings
  webhook_secret TEXT, -- For verifying incoming webhooks
  last_sync_at TIMESTAMP,
  error_message TEXT, -- Last error if status is 'error'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE integration_mappings (
  id UUID PRIMARY KEY,
  integration_id UUID NOT NULL REFERENCES integrations(id),
  local_type TEXT NOT NULL, -- 'project', 'task', 'comment', 'file'
  local_id UUID NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT, -- Direct link to item in external system
  sync_direction TEXT DEFAULT 'bidirectional', -- 'inbound', 'outbound', 'bidirectional'
  last_synced_at TIMESTAMP,
  last_local_hash TEXT, -- For conflict detection
  last_external_hash TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(integration_id, local_type, external_id)
);

CREATE TABLE integration_sync_log (
  id UUID PRIMARY KEY,
  integration_id UUID NOT NULL REFERENCES integrations(id),
  direction TEXT NOT NULL, -- 'inbound', 'outbound'
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL, -- 'create', 'update', 'delete'
  status TEXT NOT NULL, -- 'success', 'failed', 'conflict'
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Sync Architecture:**

```
┌─────────────────┐     Webhooks      ┌─────────────────┐
│    Basecamp     │ ───────────────▶  │   Webhook API   │
│    ClickUp      │                   │  /api/webhooks  │
│    Asana        │                   │    /[provider]  │
└─────────────────┘                   └────────┬────────┘
                                               │
                                               ▼
                                      ┌─────────────────┐
                                      │   Sync Queue    │
                                      │  (Redis/BullMQ) │
                                      └────────┬────────┘
                                               │
              ┌────────────────────────────────┼────────────────────────────────┐
              ▼                                ▼                                ▼
     ┌─────────────────┐              ┌─────────────────┐              ┌─────────────────┐
     │  Inbound Sync   │              │ Conflict Check  │              │  Outbound Sync  │
     │  External→Local │              │  & Resolution   │              │  Local→External │
     └─────────────────┘              └─────────────────┘              └─────────────────┘
```

**Supported Sync Items:**

| Item | Basecamp | ClickUp | Asana | Linear |
|------|----------|---------|-------|--------|
| Projects | ✓ | ✓ | ✓ | ✓ |
| Tasks | ✓ To-dos | ✓ Tasks | ✓ Tasks | ✓ Issues |
| Comments | ✓ | ✓ | ✓ | ✓ |
| Attachments | ✓ | ✓ | ✓ | ✓ |
| Status Changes | ✓ | ✓ | ✓ | ✓ |

**Webhook Events to Handle:**

```typescript
// Basecamp
'todo.created' | 'todo.updated' | 'todo.completed' | 'comment.created'

// ClickUp
'taskCreated' | 'taskUpdated' | 'taskDeleted' | 'taskCommentPosted'

// Asana
'task.added' | 'task.changed' | 'task.deleted' | 'story.added'
```

**Conflict Resolution Strategy:**
1. **Last-write-wins** for simple fields (title, description)
2. **Merge** for comments (keep all)
3. **Manual resolution** UI for complex conflicts
4. **Always sync** status changes (no conflict possible)

**UI:**
- [ ] Settings → Integrations page
- [ ] OAuth connection flow per provider
- [ ] Project mapping UI (connect external project → local project)
- [ ] Sync status indicator on tasks
- [ ] Manual sync trigger
- [ ] Sync history/log viewer

**API Endpoints:**
```
POST   /api/v1/integrations                    # Connect new integration
GET    /api/v1/integrations                    # List connected integrations
DELETE /api/v1/integrations/[id]               # Disconnect
POST   /api/v1/integrations/[id]/sync          # Trigger manual sync
GET    /api/v1/integrations/[id]/mappings      # View mappings
POST   /api/v1/integrations/[id]/mappings      # Create mapping

POST   /api/webhooks/basecamp                  # Basecamp webhook receiver
POST   /api/webhooks/clickup                   # ClickUp webhook receiver
POST   /api/webhooks/asana                     # Asana webhook receiver
```

---

## Technical Notes

### Feature Flags

Features are stored in `organizations.features` as JSONB:
```typescript
type OrgFeatures = {
  time_tracking: boolean;
  invoicing: boolean;
  pm: boolean;
  proposals: boolean;
};
```

Navigation, forms, and options adapt based on enabled features.

### Client Authentication

- Clients are users with limited scope
- Magic link auth (no password required)
- Session scoped to invited projects only
- Separate from team member auth flow

### R2 Integration

- Presigned URLs for uploads (client-side direct upload)
- Presigned URLs for downloads (time-limited access)
- Organize by: `/{org_id}/{project_id}/{file_id}/{filename}`

### AI Integration

- Document review uses existing AI setup
- Prompt: "Review this proposal for clarity, professionalism, and completeness"
- Suggest improvements, flag missing sections
- User approves changes before applying

---

## Out of Scope (Future)

- DocuSign-level signatures (simple acceptance is enough for now)
- Custom task statuses or workflows
- Gantt charts or dependencies
- Mobile native app
- Real-time collaboration (multiple editors)
- Automated payment reminders
- Multi-currency support

---

## Summary

This expansion transforms the time tracker into a complete freelancer business platform while maintaining simplicity through:

- **Modular design** - use only what you need
- **Unified concepts** - tasks serve multiple purposes
- **Two-audience UX** - power user + client experiences
- **Fixed workflows** - opinionated, not customizable
- **External integrations** - single source of truth across tools
- **Direct payments** - BYO Stripe, not a payment processor
