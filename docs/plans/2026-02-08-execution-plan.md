# Execution Plan: Documented Features → Implementation

Generated from a comprehensive review of all docs vs the actual codebase.
Organized by priority and dependency order.

---

## Current State Summary

**What's production-ready:** Time tracking, invoicing (with Stripe payments), expenses, proposals/contracts (manual editor + wizard), reports, basic PM (feature-flagged), client portal with invitations and lifecycle view (timeline, stage messaging, orientation doc, onboarding checklist), notifications with user preferences, activity tracking, discussion/comments across all entities, 8-stage project lifecycle with gated UI, onboarding checklist, agreement generation, change orders, document templates (7 engagement types), orientation auto-docs, retainer tracking (3 types with consumption dashboard, rollover, period management), project budget tracking (hours + fixed price), client notification emails (proposal-ready, agreement-ready, agreement-accepted, onboarding-complete, offboarding-started, offboarding-complete, document-shared via Resend), offboarding workflow (data export requests, migration checklist, assistance tiers, completion transition), bug reporting overlay (screenshot capture, auto-metadata, R2 storage).

**What's in schema but limited UI:** Expense import source tracking. Data export processing (request tracking built, actual export generation requires background job infrastructure).

**What's documented but not started:** Hosting management, AI document review, external integrations.

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

## ~~Tier 2: Project Lifecycle & Workflow~~ COMPLETE

### 2.1 Expand Project Stages — DONE
- Expanded from 4 to 8 stages: `getting_started` → `proposal` → `agreement` → `onboarding` → `active` → `ongoing` → `offboarding` → `completed`
- Added `VALID_STAGE_TRANSITIONS` map enforcing allowed transitions
- Built `ProjectLifecycleTimeline` visual component for project dashboard
- Updated all UI components (dialog, detail view/edit, dashboard, list page)
- Migration script maps old → new stages

### 2.2 Stage-Gated UI — DONE
- Created `lib/project-stages.ts` with `getStageCapabilities()` — controls visibility of tasks, time entry, stats, expenses, documents, etc. per stage
- Added `getStageContext()` for stage description + hint banners
- Dashboard conditionally shows/hides sections based on current stage
- Pre-active stages: no tasks, time entry, or stats. Completed: read-only.

### 2.3 Onboarding Checklist System — DONE
- Added `onboardingItems` table with categories (contacts, access, assets, review)
- Created `lib/onboarding-templates.ts` with 10 default items (2 required)
- Built `ProjectOnboardingChecklist` component with category grouping, progress bar, required badges
- API routes for init, toggle, and complete (advances to active stage)
- Auto-initializes from template on first load

### 2.4 Agreement Generation from Proposals — DONE
- Created `lib/agreement-generator.ts` — generates contract from accepted proposal content
- `handleDocumentAcceptance()` orchestrates stage transitions:
  - Proposal accepted → agreement stage + contract doc generated
  - Contract accepted → onboarding stage + checklist initialized
- Wired into public document acceptance endpoint

### 2.5 Change Order System — DONE
- Added `change_order` to `DOCUMENT_TYPES`
- Updated all document UI components, editors, and type annotations
- Change orders available in project documents panel with orange theming

---

## ~~Tier 3: Document Generation & Wizard~~ COMPLETE

### 3.1 Document Generation Wizard — DONE
- Built 4-step engagement wizard: Type → Terms → Extras → Review
- 7 engagement types: hourly, retainer, retainer+hybrid, fixed, maintenance, task, consulting
- Dynamic form fields per engagement type (rates, amounts, dates, deliverables)
- Optional addenda toggles for contracts (hosting, support expectations, responsibility matrix)
- Preview with rendered document summary before creation
- Creates document via API and navigates to editor
- `components/documents/engagement-wizard.tsx`

### 3.2 Document Templates — DONE (built as part of 3.1)
- 7 proposal templates in `lib/document-templates/proposals.ts`
- 7 contract templates in `lib/document-templates/contracts.ts` with shared common terms (IP, confidentiality, warranties, liability, termination, governing law)
- 3 addenda in `lib/document-templates/addenda.ts` (hosting, support expectations, responsibility matrix)
- Template renderer with `{Variable}` substitution in `lib/document-renderer.ts`
- Type system and engagement configs in `lib/document-templates/types.ts`

### 3.3 "How We'll Work Together" Auto-Document — DONE
- Added `orientation` to `DOCUMENT_TYPES`
- Created `lib/orientation-template.ts` with 7-section template
- Auto-creates orientation doc on every new project (POST projects route)
- Updated all document type annotations across codebase

---

## ~~Tier 4: Payment & Financial~~ COMPLETE

### 4.1 Stripe Payment Integration — DONE
- Installed Stripe SDK (v20.3.1), added `lib/payments/stripe.ts` with client, checkout session, and webhook verification utilities.
- Added invoice payment schema fields: `paidAt`, `stripePaymentIntentId`, `stripeCheckoutSessionId`, `paymentMethod`, `paymentUrl`.
- Settings page shows real Stripe connection status (connected/not configured, test/live mode, key checklist).
- Invoice send route creates Stripe Checkout Session automatically, stores payment URL on invoice.
- Email template includes "Pay Now" button when payment URL is available.
- Public invoice page shows "Pay Now" button for unpaid invoices with Stripe configured.
- Webhook handler at `/api/webhooks/stripe` verifies signatures, handles `checkout.session.completed` (marks invoice paid) and `checkout.session.expired` (clears stale URL).

### 4.2 Retainer Tracking — DONE
- Added `includedMinutes`, `overageRate` fields to clients table and `retainerPeriods` table for period tracking.
- Invoice generation now handles all 3 retainer types: fixed (flat fee), capped (min of hours*rate, cap), uncapped (max of hours*rate, floor).
- Fixed retainer generates invoices even with zero hours worked.
- Auto-invoice generation creates retainer period records with rollover (max 1 period).
- Client edit form exposes included hours and overage rate fields for retainer types.
- `RetainerWidget` on client dashboard shows usage progress, included/remaining/overage hours, rollover balance, and warnings.
- API endpoint `GET /clients/[id]/retainer` returns retainer status summary.
- `lib/retainer.ts` module for all retainer logic (period management, adjustments, status).

### 4.3 Budget vs Actual Dashboard — DONE
- Fixed project stats API to calculate real `budgetMinutes` and `budgetRemaining` (was hardcoded to null).
- Supports both hours-based and fixed-price budgets with proper conversion.
- Added budget fields (type, hours, amount) to project edit form.
- Dashboard budget card now color-codes progress bar (green < 80%, amber 80-100%, red > 100%).
- Fixed price budgets show currency remaining; hours budgets show time remaining.

---

## ~~Tier 5: Client Experience~~ COMPLETE

### 5.1 Client Portal Improvements — DONE
- Added lifecycle timeline to portal project view — visual pill-based timeline showing past stages (with checkmarks), current stage (highlighted), and next stage.
- Added stage-appropriate messaging for all 8 phases with client-facing descriptions and hints.
- Orientation document ("How We'll Work Together") now visible in portal with expand/collapse.
- Onboarding checklist visible during onboarding stage — grouped by category, contributors can toggle items, viewers see read-only.
- Created portal-facing onboarding toggle API (`/api/portal/projects/[projectId]/onboarding/[itemId]`) with invitation-based auth and contributor role check.
- Portal API updated to return `stage`, `orientationDoc`, and `onboardingChecklist`.
- Tasks and stats sections conditionally shown only for active/ongoing/offboarding/completed stages.
- Data export button deferred to Tier 6 (offboarding workflow).

### 5.2 Client Notification Emails — DONE
- Created centralized email service (`lib/email/send.ts`) with `sendEmail()` helper and `getProjectRecipients()`.
- Built reusable `LifecycleEmail` React Email template matching existing invoice/report styling.
- Created 5 lifecycle email builders (`lib/email/lifecycle-emails.ts`): proposal-ready, agreement-ready, agreement-accepted, onboarding-complete, document-shared.
- Wired into document send route — sends proposal-ready, agreement-ready, or document-shared email when a document is published (replaces TODO).
- Wired into `handleDocumentAcceptance` — sends agreement-ready email when proposal accepted, agreement-accepted email when contract accepted.
- Wired into onboarding complete route — sends onboarding-complete email when project advances to active.
- All emails sent fire-and-forget to project invitation recipients. Invoice-sent email was already built in Tier 4.

### 5.3 Repeat Client Experience — DONE
- Portal API detects repeat clients (client has multiple projects) and returns `isRepeatClient` flag.
- Portal shows lighter stage messaging for repeat clients: "The process will look familiar" (getting_started), "Since we've worked together before, some items may already be completed" (onboarding).
- Orientation document shows "Previously reviewed" badge for repeat clients with different description text.
- Delta-based onboarding: when contract is accepted, onboarding checklist items that were completed in any previous project for the same client are automatically pre-completed.
- Project creation API detects existing client projects for internal tracking.

---

## Tier 6: Offboarding & Hosting

### 6.1 Offboarding Workflow — DONE
- Added `dataExportRequests` table for tracking export request status (requested → processing → ready → expired).
- Created `lib/offboarding-templates.ts` with 8-phase migration checklist content and 3 migration assistance tier definitions (self-service, guided, hands-on).
- Built `ProjectOffboardingPanel` component with: data export request section (button + status + included/excluded info), expandable migration checklist guide, migration assistance tiers display, complete offboarding button.
- API routes: `offboarding/export` (GET status, POST request), `offboarding/complete` (POST → advances to completed stage).
- Offboarding email sent when project transitions to offboarding stage; completion email sent when project advances to completed.
- Added 3 lifecycle email builders: `offboardingStartedEmail`, `dataExportReadyEmail`, `offboardingCompleteEmail`.
- Portal shows offboarding section with data export info, migration checklist, and migration assistance options.
- Dashboard conditionally shows offboarding panel when stage === "offboarding".

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

### 8.4 Bug Reporting Overlay — DONE
- Added `bugReports` table with status tracking (new/reviewed/resolved/dismissed), automatic metadata capture, and R2 screenshot storage key.
- Built `BugReportOverlay` component: floating bug icon button → click activates → auto-captures screenshot via html2canvas → description textarea → submit.
- Automatically captures: page URL, viewport size, browser, OS, user agent, theme (dark/light).
- Screenshot uploaded to R2 via presigned URL (non-blocking, report created even if upload fails).
- API route `POST /api/v1/bug-reports` creates report + returns presigned upload URL; `GET` lists reports for org.
- Overlay mounted in app layout — visible only to authenticated users, never on public pages.
- Follows philosophy: invisible until needed, minimal UI, zero configuration, no cognitive load.

### 8.5 Notification Preferences — DONE
- Created `NotificationPreferences` component on settings page with toggle switches for all 5 notification types + email toggle.
- Uses existing `GET/PATCH /api/v1/notifications/preferences` API.
- Optimistic updates with automatic save.
- Notification bell's "Settings" link updated to scroll to preferences section (`/settings#notifications`).
- Schema and API were already complete — this adds the missing UI.

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
