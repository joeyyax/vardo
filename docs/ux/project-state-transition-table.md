# Project State Transition Table

This document defines all valid project states, allowed transitions, required conditions (guards), and side effects.

The goal is to:
- Prevent invalid state changes
- Make transitions explicit and predictable
- Ensure emails, docs, and UI stay aligned

A project may exist in exactly one state at a time.

---

## Canonical States

| State | Description |
|------|-------------|
| inquiry | Internal-only lead, no project yet |
| getting_started | Project exists, orientation phase |
| proposal | Proposal drafted or under review |
| agreement | Agreement under review |
| onboarding | Access gathering and setup |
| active | Work in progress |
| ongoing | Long-term support / retainer |
| offboarding | Project or hosting ending |
| completed | Project fully concluded (no hosting) |

---

## State Transition Rules

### inquiry → getting_started
**Trigger**
- Project is created for a client

**Guards**
- Client exists
- Project name provided

**Side Effects**
- Project dashboard created
- Lifecycle timeline becomes visible
- “How We’ll Work Together” doc attached
- Welcome / Getting Started email sent

---

### getting_started → proposal
**Trigger**
- Proposal draft is created

**Guards**
- Project exists
- No active proposal already exists

**Side Effects**
- Proposal document created (Draft)
- Proposal added to Project Docs
- Project status updated to Proposal

---

### proposal → proposal (internal loop)
**Trigger**
- Proposal edited or re-saved before sending

**Guards**
- Proposal not yet sent

**Side Effects**
- Proposal version updated
- No email sent

---

### proposal → agreement
**Trigger**
- Client accepts proposal

**Guards**
- Proposal has been sent
- Proposal not previously accepted

**Side Effects**
- Proposal marked Accepted
- Proposal snapshot saved (immutable)
- Agreement generated from proposal snapshot
- Agreement and addenda added to Project Docs
- Project status updated to Agreement
- Agreement email sent

---

### agreement → agreement (regeneration)
**Trigger**
- Agreement is regenerated after discussion

**Guards**
- Agreement not yet accepted

**Side Effects**
- Previous agreement version archived
- New agreement generated
- Client notified only if explicitly sent

---

### agreement → onboarding
**Trigger**
- Client accepts agreement

**Guards**
- Agreement exists
- Agreement not previously accepted

**Side Effects**
- Agreement snapshot saved (immutable)
- Onboarding checklist generated
- Onboarding email sent
- Project status updated to Onboarding

---

### onboarding → onboarding (partial completion)
**Trigger**
- Onboarding checklist items completed

**Guards**
- Agreement accepted

**Side Effects**
- Checklist progress updated
- No state change

---

### onboarding → active
**Trigger**
- Provider marks onboarding complete

**Guards**
- All required onboarding checklist items are completed

**Constraints**
- Clients cannot trigger this transition
- Clients do not have access to a “complete onboarding” action

**Side Effects**
- Onboarding checklist is locked (read-only)
- Checklist snapshot is saved to Project Docs
- Project state updates to Active
- “Work is underway” email is sent

---

### active → ongoing
**Trigger**
- Project transitions into retainer / maintenance mode

**Guards**
- Retainer or ongoing agreement exists

**Side Effects**
- Project status updated to Ongoing
- Ongoing support email sent (optional)

---

### active → offboarding
**Trigger**
- Hosting ended OR project termination initiated

**Guards**
- Project is Active

**Side Effects**
- Project status updated to Offboarding
- Offboarding email sent
- Migration resources attached

---

### ongoing → offboarding
**Trigger**
- Retainer or hosting is ended

**Guards**
- Project is Ongoing

**Side Effects**
- Same as Active → Offboarding

---

### offboarding → completed
**Trigger**
- Offboarding confirmed complete

**Guards**
- Data export available or acknowledged
- No active hosting remains

**Side Effects**
- Project status updated to Completed
- Project becomes read-only
- Final audit trail preserved

---

## Invalid Transitions (Explicitly Disallowed)

| From | To | Reason |
|----|----|--------|
| getting_started | agreement | Proposal required |
| getting_started | active | Agreement + onboarding required |
| proposal | active | Agreement required |
| agreement | active | Onboarding required |
| onboarding | proposal | Proposal already accepted |
| completed | any | Completed is terminal |

---

## Global Constraints

- A project may have only one active proposal at a time
- A project may have only one active agreement at a time
- Active work must never begin before onboarding completes
- Clients never see drafts or internal-only states
- All transitions must be auditable (who, when, why)

---

## Email Alignment

Each state transition may trigger **at most one email**.

Emails are:
- Informational
- Phase-aligned
- Never surprising

Timers (reminders) must not advance state.

---

## Summary

This state machine:
- Enforces clarity
- Prevents accidental early work
- Keeps UX, docs, and email in sync
- Makes the system hard to misuse

If the UI ever feels confusing, the state machine is the place to look first.