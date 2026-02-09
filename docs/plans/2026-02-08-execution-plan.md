# Execution Plan: Documented Features → Implementation

Generated from a comprehensive review of all docs vs the actual codebase.
Organized by priority and dependency order.

---

## Current State Summary

**What's production-ready:** Time tracking, invoicing, expenses, proposals/contracts (manual editor), reports, basic PM (feature-flagged), client portal with invitations, notifications, activity tracking, discussion/comments across all entities.

**What's in schema but limited UI:** Complex billing types (retainer variants), payment provider config, expense import source tracking.

**What's documented but not started:** Hosting management, offboarding workflow, document generation wizard, full 8-stage lifecycle, AI document review, external integrations.

---

## ~~Tier 1: Foundation & Quick Wins~~ COMPLETE

### 1.1 Privacy & Terms Pages — DONE
- Built `/privacy` and `/terms` from doc content. Server components with prose styling.

### 1.2 Marketing Copy Alignment Pass — DONE
- Updated homepage, pricing, how-it-works, why (full redesign), for-you pages.
- Anchored to "client work lifecycle system" positioning.
- Incorporated "measurement vs billing" distinction throughout.
- All pages pass lint.

### 1.3 FAQ / Internal Work Page — DONE
- Built `/faq/internal-work` with full visual design (MagicCards, two-column layouts, includes/excludes comparison).
- Content from `docs/pages/faq-internal-work-page.md` plus "measurement vs billing" philosophy section.

### 1.4 Billing Config UI Completion — DONE
- **Finding:** Client billing was already fully implemented (all fields exposed in `client-detail-edit.tsx`).
- **Gap was org-level defaults only.** Added defaultBillingType, defaultBillingFrequency, and defaultPaymentTermsDays to the org settings form (`settings-form.tsx`).
- Gated behind `features.invoicing`. API already supported all three fields with validation.
- UI matches existing client billing patterns (same select options, descriptions, layout).

---

## Tier 2: Project Lifecycle & Workflow

These bring the core product vision to life. The docs describe a precise, gated lifecycle — the code currently has a simplified version.

### 2.1 Expand Project Stages
- **Effort:** Medium-Large (3-5 sessions)
- **What:** Expand project stages from current 4 (`lead`, `proposal_sent`, `active`, `completed`) to match docs:
  - `getting_started` → `proposal` → `agreement` → `onboarding` → `active` → `ongoing` → `offboarding` → `completed`
- **Schema changes:** Update `projectStages` enum, add migration
- **UI changes:** Project dashboard stage indicator, stage transition controls, gated actions per stage
- **Why:** This is THE core product concept. Everything else builds on it.
- **Dependencies:** None (but blocks 2.2-2.5)
- **Docs:** `docs/ux/client-project-lifecycle.md`, `docs/ux/project-state-transition-table.md`, `docs/ux/permissions-by-state.md`

### 2.2 Stage-Gated UI
- **Effort:** Medium (2-3 sessions)
- **What:** Implement `docs/ux/ui-enabled-elements-by-state.md` — show/hide/disable UI elements based on current project stage:
  - Getting Started: Only proposal creation available
  - Proposal: Proposal editing/sending, no task creation
  - Agreement: Agreement review, no work execution
  - Onboarding: Checklist visible, no time entry
  - Active: Full access
  - Ongoing: Capacity tracking, maintenance mode
  - Offboarding: Data export, migration tools
  - Completed: Read-only
- **Why:** Prevents accidental early work. Core UX principle: "Never start work before agreement."
- **Dependencies:** 2.1

### 2.3 Onboarding Checklist System
- **Effort:** Medium (2-3 sessions)
- **What:** Build structured onboarding checklist that appears after agreement acceptance:
  - Dynamic checklist items based on project type
  - Items like: gather access credentials, confirm contacts, upload assets
  - Provider marks complete → advances to Active
  - Delta-based for repeat clients (skip items that exist from prior projects)
- **Why:** Bridges agreement → active work. Prevents "work starts before we're ready."
- **Dependencies:** 2.1
- **Docs:** `docs/ux/onboarding-stage-ux.md`, `docs/ux/onboarding-first-project.md`

### 2.4 Agreement Generation from Proposals
- **Effort:** Medium (2-3 sessions)
- **What:** When a proposal is accepted, auto-generate an agreement document:
  - Snapshot proposal terms into agreement
  - Add relevant addenda (SOW, support expectations, etc.)
  - Client reviews and accepts agreement separately
  - Acceptance triggers onboarding stage
- **Why:** Currently proposals and contracts are separate manual documents. The lifecycle expects them to be connected.
- **Dependencies:** 2.1, existing proposals/contracts system
- **Docs:** `docs/ux/agreement-stage-ux.md`

### 2.5 Change Order System
- **Effort:** Small-Medium (1-2 sessions)
- **What:** When scope needs to change mid-project:
  - Create a change order document (predefined structure)
  - Client reviews and accepts
  - Updates project terms/pricing
- **Why:** Scope changes are a core concern. Currently no mechanism to handle them formally.
- **Dependencies:** 2.1, document system
- **Docs:** `docs/legal/change-order.md`

---

## Tier 3: Document Generation & Wizard

The docs describe a sophisticated document assembly system. Currently documents are manually edited section-by-section.

### 3.1 Document Generation Wizard
- **Effort:** Large (5-8 sessions)
- **What:** Multi-step guided interface for creating proposals and contracts:
  1. Client info (auto-filled from project)
  2. Link existing proposal or create new
  3. Engagement type selection (hourly, retainer, fixed, maintenance, consulting, task)
  4. Core terms (varies by type — rates, amounts, deliverables)
  5. Hosting toggle (if applicable)
  6. Optional addenda (SOW, support expectations, responsibility matrix)
  7. Review & preview
  8. Send for acceptance
- **Why:** Currently requires manual section-by-section editing. The wizard would make document creation fast and consistent.
- **Dependencies:** 1.4 (billing config), 2.1 (stages)
- **Docs:** `docs/legal/wizard-schema.md`, all files in `docs/legal/contracts/` and `docs/legal/proposals/`

### 3.2 Document Templates
- **Effort:** Medium (3-4 sessions)
- **What:** Pre-built templates for each engagement type:
  - 7 proposal templates (hourly, fixed, retainer, retainer+hybrid, maintenance, task, consulting)
  - 7 contract templates (matching)
  - Supporting document templates (SOW, change order, responsibility matrix, etc.)
- **Why:** The docs contain full template content. This is the content layer for the wizard.
- **Dependencies:** 3.1
- **Docs:** All files in `docs/legal/contracts/` and `docs/legal/proposals/`

### 3.3 "How We'll Work Together" Auto-Document
- **Effort:** Small (1 session)
- **What:** Auto-generate a "How We'll Work Together" document when a new client project enters Getting Started stage. Sets communication norms and expectations.
- **Why:** Establishes trust before scope discussions. Core UX principle.
- **Dependencies:** 2.1
- **Docs:** `docs/legal/how-we-will-work-together.md`

---

## Tier 4: Payment & Financial

### 4.1 Stripe Payment Integration
- **Effort:** Medium (3-4 sessions)
- **What:** Connect Stripe for invoice payments:
  - Payment links on sent invoices
  - Webhook handlers for payment confirmation
  - Auto-update invoice status on payment
  - Payment method storage (optional)
- **Why:** Currently invoices are sent but payment is tracked manually. Schema has `paymentConfig` ready.
- **Dependencies:** None
- **Docs:** `docs/PLATFORM_EXPANSION.md` (Phase 9)

### 4.2 Retainer Tracking
- **Effort:** Medium (2-3 sessions)
- **What:** For retainer-type billing:
  - Track included hours vs used hours per period
  - Rollover logic (one month only, as defined in docs)
  - Dashboard widget showing retainer status
  - Auto-invoice for overage hours
- **Why:** Schema supports retainer billing types. No UI to track/manage retainer consumption.
- **Dependencies:** 1.4

### 4.3 Budget vs Actual Dashboard
- **Effort:** Small-Medium (1-2 sessions)
- **What:** Project-level widget showing estimated vs actual time and cost.
- **Why:** Key insight tool for project profitability. Reports exist but per-project budget tracking doesn't.
- **Dependencies:** None

---

## Tier 5: Client Experience

### 5.1 Client Portal Improvements
- **Effort:** Medium (2-3 sessions)
- **What:**
  - Lifecycle timeline visible to clients (shows current stage, what's next)
  - Stage-appropriate messaging per phase
  - "How We'll Work Together" document visible from portal
  - Onboarding checklist items clients can complete
  - Data export request button (for offboarding)
- **Why:** Portal exists but doesn't reflect the lifecycle concept.
- **Dependencies:** 2.1, 2.3
- **Docs:** `docs/ux/client-visibility-model.md`, `docs/ux/client-board-behavior.md`

### 5.2 Client Notification Emails
- **Effort:** Medium (2-3 sessions)
- **What:** Build transactional email templates for client-facing events:
  - Proposal ready for review
  - Agreement ready for signing
  - Onboarding started
  - Project active
  - Invoice sent
  - Document shared
- **Why:** Email templates are fully written in `docs/emails/content/`. Currently limited email support.
- **Dependencies:** None
- **Docs:** All files in `docs/emails/content/`

### 5.3 Repeat Client Experience
- **Effort:** Small-Medium (1-2 sessions)
- **What:** When creating a new project for an existing client:
  - Lighter "Getting Started" messaging ("This will look familiar")
  - Delta-based onboarding (reuse existing contacts/access, only request new items)
  - Pre-fill from previous project data
- **Why:** Reduces friction for ongoing client relationships.
- **Dependencies:** 2.1, 2.3
- **Docs:** `docs/ux/repeat-client-new-project-ux.md`

---

## Tier 6: Offboarding & Hosting

These features are fully documented but entirely absent from the codebase.

### 6.1 Offboarding Workflow
- **Effort:** Medium (2-3 sessions)
- **What:**
  - Offboarding project stage with structured exit flow
  - Data export request (automated: code, DB backup, media files)
  - Migration checklist generation (self-serve guide)
  - Optional migration assistance tiers (guided, hands-on)
  - Transition to Completed state
- **Why:** "Never lock clients in" is a core principle. No exit mechanism exists.
- **Dependencies:** 2.1
- **Docs:** `docs/ux/offboarding-and-hosting-ux.md`, `docs/legal/migration-*`

### 6.2 Hosting Management (Future)
- **Effort:** Large (5+ sessions)
- **What:** Manage client hosting deployments:
  - Hosting option in proposals
  - Hosting-specific onboarding items
  - Storage ownership tracking
  - Hosting addendum generation
  - "End Hosting" trigger → offboarding
- **Why:** Major platform capability described in docs but entirely absent. May be a later phase.
- **Dependencies:** 2.1, 3.1, 6.1
- **Docs:** `docs/legal/hosting-addendum.md`, `docs/ux/offboarding-and-hosting-ux.md`

---

## Tier 7: Import & Integration

### 7.1 Expense Import Integrations
- **Effort:** Large (4-6 sessions per integration)
- **What:**
  - Plaid bank transaction import
  - Email receipt forwarding (unique org email → expense inbox)
  - Paperless-ngx OCR integration
  - Auto-categorization by vendor
- **Dependencies:** Expense system (built)
- **Docs:** `docs/PLATFORM_EXPANSION.md` (Phase 10)

### 7.2 External PM Integrations
- **Effort:** Very Large (per integration)
- **What:** Bidirectional sync with Basecamp, ClickUp, Asana, Linear, Notion
- **Dependencies:** PM system (built)
- **Docs:** `docs/PLATFORM_EXPANSION.md` (Phase 13)

---

## Tier 8: Polish & Enhancement

### 8.1 Rich Document Editor
- **Effort:** Medium (2-3 sessions)
- **What:** Replace basic section editor with Tiptap WYSIWYG editor for proposals/contracts
- **Docs:** `docs/PLATFORM_EXPANSION.md` (Phase 12)

### 8.2 Mobile-Responsive Portal
- **Effort:** Medium (2-3 sessions)
- **What:** Ensure client portal is fully usable on mobile devices

### 8.3 AI Document Review
- **Effort:** Medium (2-3 sessions)
- **What:** AI-powered review of proposals/contracts for clarity and completeness
- **Docs:** `docs/PLATFORM_EXPANSION.md`

### 8.4 Bug Reporting Overlay
- **Effort:** Small-Medium (1-2 sessions)
- **What:** In-app bug reporting overlay with screenshot capture and context payload
- **Docs:** `docs/bug-reporting/`

### 8.5 Notification Preferences
- **Effort:** Small (1 session)
- **What:** User preferences for which notifications they receive and how (in-app, email, both)

---

## Recommended Execution Order

```
Phase A (Foundation):     1.1 → 1.2 → 1.3 → 1.4
Phase B (Lifecycle):      2.1 → 2.2 → 2.3 → 2.4 → 2.5
Phase C (Documents):      3.3 → 3.1 → 3.2
Phase D (Financial):      4.1 → 4.2 → 4.3
Phase E (Client):         5.2 → 5.1 → 5.3
Phase F (Exit):           6.1 → 6.2
Phase G (Import):         7.1 → 7.2
Phase H (Polish):         8.1-8.5 (parallel, as needed)
```

Phases A-B are foundational. Everything else can be prioritized based on user needs.

---

## Notes

- **The project lifecycle expansion (Tier 2) is the single highest-impact change.** It transforms Scope from "a nice set of tools" into "the client work lifecycle system" that the docs describe.
- **Marketing pages should be updated (1.2) before or alongside lifecycle work** to avoid promising things that aren't built yet — or underselling things that are.
- **Hosting management (6.2) is the largest and most complex feature.** It may make sense to defer this entirely until the core lifecycle is solid.
- **External integrations (7.2) are explicitly Phase 13 in the platform expansion doc.** These are intentionally last.
