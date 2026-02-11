# Agreement Stage UX

This document defines the user experience for reviewing and accepting an agreement after a proposal has been approved.

The Agreement stage exists to formalize the engagement before any work begins.

---

## Entry Point

### When this stage begins

- Proposal has been accepted by the client
- Project state advances automatically to **Agreement**

The agreement is generated from a snapshot of the accepted proposal.

---

## Project Page — Agreement Stage

### Status

> **Agreement**  
> We’re locking in the details so work can begin.

### Visible Elements

- Lifecycle timeline
  - Proposal (completed)
  - Agreement (current)
  - Onboarding (locked)
  - Active (locked)

- Agreement document
- Any relevant addenda:
  - Hosting Addendum (if applicable)
  - Statement of Work (if applicable)
  - Support Expectations (if applicable)

All documents appear in **Project Docs** immediately.

---

## Agreement Document

### Characteristics

- Generated automatically
- Read-only by default
- References:
  - Accepted proposal
  - Client
  - Project
- Plain, client-friendly language

The agreement should feel like:
> “This matches what we already discussed.”

---

## Primary Action

- **Accept agreement**

This is the only primary action in this stage.

---

## Secondary Actions

- View linked proposal
- Ask questions (via workspace discussion)
- Download agreement (optional)

Editing the agreement is not supported in-UI.
Changes happen through conversation and regeneration if needed.

---

## Client Experience

### Client Sees

- Project status: **Agreement**
- Agreement and addenda
- One clear action:
  - **Accept agreement**

No onboarding tasks are visible yet.

This reinforces:
> “Nothing starts until this is agreed.”

---

## Acceptance Flow

### Client clicks “Accept agreement”

System records:
- Acceptance timestamp
- Accepting contact
- Agreement snapshot (immutable)

System behavior:
- Agreement is marked **Accepted**
- Project state advances to **Onboarding**
- Onboarding checklist is generated
- “Onboarding” email is sent

---

## Important UX Constraints

- Agreement acceptance is required before onboarding
- Agreement cannot be partially accepted
- Agreement acceptance does not trigger work directly
- Agreement changes require regeneration, not inline edits

---

## UX Principles

- Formal, but calm
- No surprises
- One clear decision
- No premature access requests

The agreement should feel like a checkpoint, not a hurdle.

---

## Summary

The Agreement stage:
- Formalizes the relationship
- Protects both sides
- Creates a clean handoff to onboarding

It exists to make starting work feel intentional and safe.