# Scope — App Brief

## Purpose

Scope is a calm, opinionated system for running client work without chaos.

It connects time, tasks, projects, proposals, contracts, expenses, and billing into a single, predictable workflow — without becoming an admin-heavy tool or an all-in-one platform.

Scope is designed to **reduce cognitive load**, not maximize flexibility.

---

## What Scope Is

Scope is a **client work lifecycle system**.

It is built around the reality that client work follows a sequence:

**Getting Started → Proposal → Agreement → Onboarding → Active → Ongoing → Offboarding → Completed**

Scope makes this lifecycle explicit and supports each stage with structure, defaults, and visibility — from the first conversation to the final handoff.

---

## What Scope Is Not

Scope is not:

- a configurable work OS
- a productivity dashboard
- an enterprise platform
- a timer-first time tracker
- an AI system making decisions for the user

Scope does not attempt to infer intent or optimize engagement.

---

## Core Principles

### 1. Structure beats flexibility
Clear structure prevents chaos better than unlimited configuration.

### 2. Calm is a feature
Nothing should surprise, nag, guilt, or disappear unexpectedly.

### 3. Explicit beats implicit
Work does not begin until it is agreed. Scope does not assume.

### 4. Automation supports judgment
Automation removes repetition; it does not replace decision-making.

### 5. History is sacred
Data is never hidden, altered, or removed without explicit intent.

---

## Core Concepts

### Organizations
All work exists within an organization.
Data is isolated and scoped by design.

### Teams
Organizations support multiple members with intentional access control.

- Three roles: **owner**, **admin**, **member**
- Admins have full access; members see only their assigned projects
- Join via invitation or shareable team link
- **Default assignee** setting routes new entities to the right person automatically
- Bulk reassignment when team composition changes

### Assignment Inheritance
New entities inherit their assignee through a chain: explicit assignment → project owner → client owner → organization default. Single-user organizations auto-set the default assignee on creation. When a second member joins, the owner is nudged to review assignment defaults.

### Clients
Clients represent work contexts.

- External clients are billable by default
- Every organization includes an **Internal** client
- Internal work is fully tracked but never invoiced
- Clients can be nested one level (e.g., Agency → End Client)
- Each client can have contacts (primary, billing, other)
- Optional **owner** (assigned team member responsible for the client)

### Projects
Projects represent bounded scopes of work.

- Each project moves through a defined lifecycle:
  Getting Started → Proposal → Agreement → Onboarding → Active → Ongoing → Offboarding → Completed
- Projects never skip phases — they only move through them faster
- Archiving closes work without deleting history
- Default views show Active projects only
- Projects carry budgets, rates, and billing configuration
- Optional **owner** (assigned team member responsible for the project)

### Tasks
Tasks execute inside projects.

- Tasks serve dual purpose: time tracking categories and structured work items
- Statuses: todo, in progress, review, done
- Optional: priority, assignee, estimate, tags, types, relationships, **due date**
- Client visibility is intentional
- Task movement reflects work, not status theater

### Time Entries
Time is captured manually.

- Keyboard-first
- No timers
- Predictive suggestions based on recent usage and time-of-week patterns
- Recurring templates for repetitive entries
- Fast entry

Time is an input, not the system.

---

## Documents

Scope handles the paperwork that precedes and governs work.

### Proposals
- Structured documents with pricing, scope, and terms
- Built from org-level templates with variable substitution
- Sent to clients via email with public viewing link
- Clients accept or decline directly

### Contracts
- Same document system, different purpose
- Types: hourly, retainer, fixed, maintenance, consulting, task-based
- Acceptance tracking with timestamps

### Supporting Documents
- Change orders, orientation guides, addendums
- All follow the same template → draft → send → accept lifecycle

### Template System
- Org-scoped templates with sections, variables, and pricing config
- TipTap-based rich text editor
- Revision history and collaborative editing with document locking

---

## Billing & Invoicing

Scope connects tracked work to money.

### Invoicing
- Manual or auto-generated rolling drafts
- Statuses: draft → sent → viewed → paid (or voided)
- Line items snapshot project and task data at creation time
- Public link for client viewing and payment

### Billing Types
- Hourly (bill by time at rate)
- Retainer: fixed, capped, or uncapped
- Fixed project (one-time)

### Retainer Tracking
- Monthly periods with included, used, and rollover minutes
- Linked to invoices for audit trail

### Payments
- Stripe Checkout integration
- Payment status tracking

Scope is not accounting software. It handles the billing that naturally follows tracked work — nothing more.

---

## Expenses

Expenses track costs associated with projects or the organization.

- Manual entry or converted from inbound email
- Optional: receipt attachment, vendor, category, billable flag
- Recurring expenses with auto-generation
- Categories: software, hosting, contractor, travel, supplies

---

## Client Portal

Clients can see their own work without needing a Scope account.

- Invitation-based access at the client or project level
- Two roles: **viewer** (read-only) and **contributor** (can comment)
- Visibility controls per invitation (rates, time, costs)
- Portal shows: project dashboard, onboarding checklist, public files, shared discussions, activity timeline
- Token-based authentication — no client login required

---

## Discussions

Every major entity supports threaded discussion.

- Comments on clients, projects, tasks, expenses, invoices, and documents
- Internal vs shared visibility — shared comments appear in the client portal
- Pinnable comments
- Watcher system with auto-subscribe on participation
- Unified timeline merging comments and activity history

---

## Inbox

Inbound email as a lightweight intake system.

- Forward emails to a project or client intake address
- Items land in a review queue
- Convert to: expense, file, discussion item, task, or transfer to another entity
- Attachments are extracted and stored automatically
- Inbox items are auto-assigned via inheritance (project → client → org default)

---

## Notifications

Scope keeps users informed without being noisy.

- In-app notification center
- Email notifications (immediate or daily digest)
- Per-type preferences (assignments, mentions, status changes, comments)
- Triggered by: task assignment, comments, status changes, client actions

---

## Reporting

Reports exist for **reflection**, not surveillance.

- Overview, accounting, and client-facing report tabs
- Time breakdown by client, project, and task
- Revenue, utilization, and expense charts
- Shareable client reports via public URL
- Auto-send scheduling (weekly, configurable day/hour)
- Saved filter presets per user
- CSV export for time entries and expenses

Reports should confirm intuition, not replace it.

---

## Search & Selection Philosophy

Search uses **progressive disclosure**:

- Active and recently used items appear first
- Archived or inactive items appear only with explicit intent
- Nothing expands automatically
- Nothing disappears silently

This keeps search fast, predictable, and trustworthy.

---

## Personal Work

The system must remain useful for solo, personal projects.

- No feature should require a client to exist
- No workflow should depend on external approval to function
- Client-facing features layer on top of the core, not replace it

Client collaboration is one mode of operation — not a prerequisite.

---

## Internal Work

Internal work is first-class.

Internal projects:

- are tracked like any other project
- appear in reports
- contribute to metrics
- are never invoiced
- never count against plan limits

Internal work reflects the reality that businesses have non-client obligations.

---

## Pricing Philosophy

Pricing is:

- predictable
- flat
- calm

Scope does not:

- charge per seat
- charge per project
- charge per task
- meter time
- lock core features behind plans

Limits exist only to prevent abuse, not punish success.

---

## Intended Audience

Scope is built for:

- freelancers
- consultants
- small studios
- boutique agencies

Especially people who:

- already know how they work
- care about boundaries
- are tired of duct-taped tools
- want fewer decisions, not more options

---

## Design Language

- Quiet
- Neutral
- Editorial
- Functional
- No novelty UI
- No celebratory UX
- No gamification

Settings should be boring.
Work should be clear.
Reports may have light visual flair.

---

## Non-Goals

Scope intentionally does not aim to:

- replace full accounting or bookkeeping software
- manage HR or payroll
- track performance or utilization targets
- become a general-purpose work platform
- automate business decisions
- support real-time collaboration or co-editing workflows

---

## Summary

Scope exists to make client work feel **predictable and contained**.

When Scope is working well:

- users think less about their tools
- work is easier to reason about
- billing feels inevitable
- history feels safe
- nothing is surprising

That is the product.
