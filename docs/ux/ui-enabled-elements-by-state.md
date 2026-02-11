# UI Enabled Elements by State

This document defines which UI sections, documents, and actions are visible/enabled in each project state.

Goals:
- Keep the client oriented
- Ensure “one primary action” in early phases
- Prevent premature access requests or task intake
- Make docs appear as byproducts of progress

---

## Global UI Structure (Project Page)

Always visible:
- Project name
- Current state (status)
- Lifecycle timeline (past/current/future)
- Recent activity (small)
- Discussions (read-only or active depending on state)
- Project Docs (filtered by state)

---

## State: getting_started

Visible:
- Status banner: Getting Started
- Lifecycle timeline (future locked)
- Doc: How We’ll Work Together
- Discussions: enabled
- Project Docs: shows orientation doc(s)

Enabled actions:
- Provider: Create proposal
- Client: Comment / ask questions

Primary action (provider):
- Create proposal

Primary action (client):
- Ask a question (or none, if you want zero pressure)

Hidden/disabled:
- Tasks
- Agreement
- Onboarding checklist
- Exports

---

## State: proposal

Visible:
- Status banner: Proposal
- Proposal doc (client-visible once sent)
- Discussions: enabled
- Project Docs: proposal + orientation

Enabled actions:
- Provider: Edit proposal, Send proposal
- Client: View proposal, Accept proposal (decision authority), Comment

Primary action:
- Provider: Send proposal (if draft)
- Client: Review proposal (if sent)

Hidden/disabled:
- Agreement (locked)
- Onboarding checklist (locked)
- Tasks (hidden)

---

## State: agreement

Visible:
- Status banner: Agreement
- Agreement doc + relevant addenda
- Link to accepted proposal snapshot
- Discussions: enabled
- Project Docs: proposal + agreement + addenda

Enabled actions:
- Provider: Regenerate agreement (internal), respond to questions
- Client: Accept agreement (decision authority), comment/questions

Primary action:
- Client: Accept agreement

Hidden/disabled:
- Onboarding checklist (locked)
- Tasks (hidden)
- Exports (unless hosting enabled and you want early visibility—recommended: keep hidden)

---

## State: onboarding

Visible:
- Status banner: Onboarding
- Onboarding checklist (progress UI)
- Contacts confirmation panel
- Upload/link inputs (assets)
- Discussions: enabled
- Project Docs: agreement set + onboarding checklist (live)

Enabled actions:
- Client: Complete onboarding items, add contacts, upload assets
- Provider: Same + mark onboarding complete

Primary action:
- Complete onboarding checklist

Disabled:
- Creating normal tasks/requests (optional)
  - Recommendation: allow “notes/questions” but not task intake yet, to avoid scope creep.

Conditional visibility:
- Hosting section (only if hosting enabled)
- Storage setup confirmation (only if applicable)

---

## State: active

Visible:
- Status banner: Active
- Tasks list (enabled)
- Project Docs (all current)
- Discussions/updates (enabled)
- Optional: Status updates / “What’s in progress”

Enabled actions:
- Client: Create request/task, comment, view docs
- Provider: All task actions + docs creation

Primary action:
- Create a request (client)
- Create/manage tasks (provider)

Conditional visibility:
- Usage/capacity (if retainer/hours tracking enabled)
- Approvals (if you support approvals)

---

## State: ongoing

Visible:
- Status banner: Ongoing
- Tasks list (enabled)
- Optional: usage/capacity panel
- Project Docs (all)
- Discussions/updates (enabled)

Enabled actions:
- Same as Active

Primary action:
- Create request

Conditional visibility:
- “End ongoing service” request (client-facing)
  - Should create an offboarding request, not auto-transition.

---

## State: offboarding

Visible:
- Status banner: Offboarding
- Request application data export (button + status)
- Migration checklist
- Migration assistance options
- Project Docs (includes exports and migration docs)
- Discussions (enabled, but focused)

Enabled actions:
- Client: Request export, request migration assistance, ask questions
- Provider: Manage offboarding, generate exports, assist migration

Primary action:
- Request application data

Disabled:
- New task creation
- New scope intake
- Proposal/agreement generation

---

## State: completed

Visible:
- Status banner: Completed
- Project Docs (archival)
- Discussions (read-only recommended)

Enabled actions:
- View-only by default
- Optional: request export (if retention policy supports)

Disabled:
- Task creation
- New documents (except internal notes, if you want)

---

## Summary

Early states enforce clarity:
- One primary action
- Minimal visible surface area
- No tasks until Active

Later states support day-to-day collaboration:
- Tasks, docs, updates

Offboarding and completed are intentionally constrained:
- Export and migration only
- Archival, not a new project start