# Proposal Stage UX

This document defines the user experience for creating, reviewing, and accepting a proposal within a project.

The Proposal stage is the first moment where scope and pricing are introduced.
It should feel deliberate, calm, and reversible.

---

## Entry Point

### When this stage begins

- A Project exists
- Project state is **Getting Started**
- No proposal has been created yet

Primary action becomes:
- **Create proposal**

---

## Project Page — Before Proposal Exists

### Status

> **Getting Started**  
> We’re setting things up and aligning on next steps.

### Visible Elements

- Lifecycle timeline
  - Getting Started (current)
  - Proposal (next)
  - Agreement (locked)
  - Onboarding (locked)
  - Active (locked)

- “How We’ll Work Together” document (visible, read-only)

### Primary Action

- **Create proposal**

### Secondary Actions

- Add internal notes
- Edit contacts (non-blocking)

No proposal-related UI is shown yet.

---

## Create Proposal

### Purpose

Create a draft proposal without committing to anything.
This step is internal-first and safe to iterate.

---

### Proposal Creation Form

The proposal is assembled, not “written from scratch”.

#### Required Inputs

- Proposal type
  - Hourly
  - Retainer
  - Retainer + Additional Hours
  - Fixed Scope
  - Maintenance / Ongoing

- Scope description
  - Freeform text
  - May be assisted later (AI, templates, etc.)

- Pricing
  - Depends on proposal type
  - Clear, human-readable summary

#### Optional Inputs

- Assumptions
- High-level timeline
- Notes (client-facing)

No legal terms are introduced here.

---

### Save Draft

When saved:
- Proposal is created in **Draft** state
- Proposal appears in **Project Docs**
- Project state moves to **Proposal**
- Proposal is editable

No email is sent yet.

---

## Project Page — Proposal Stage (Draft)

### Status

> **Proposal**  
> Review the proposed work and pricing.

### Visible Elements

- Proposal document (Draft)
- Lifecycle timeline
  - Proposal (current)
  - Agreement (locked)

### Primary Action

- **Send proposal to client**

### Secondary Actions

- Edit proposal
- View internal notes

Client does **not** yet have access.

---

## Send Proposal

### Action

User clicks **Send proposal to client**

### System Behavior

- Proposal is locked (or versioned)
- Proposal becomes client-visible
- “Proposal ready” email is sent
- Timestamp is recorded

Optional:
- Allow internal note before sending

---

## Client Experience — Proposal Stage

### Client Sees

- Project status: **Proposal**
- Proposal document
- One clear action:
  - **Review proposal**

No agreement, onboarding, or tasks are visible yet.

---

### Client Actions

- Read proposal
- Ask questions (via workspace discussion)
- Accept proposal

Rejection or edits are handled conversationally, not via UI complexity.

---

## Proposal Accepted

### Trigger

Client clicks **Accept proposal**

### System Behavior

- Proposal is marked **Accepted**
- Proposal becomes read-only
- Proposal snapshot is saved
- Project state advances to **Agreement**
- Agreement document is generated

Proposal acceptance does *not* start work.

---

## Key UX Constraints

- Only one active proposal per project at a time
- Editing is allowed until proposal is sent
- Clients never see drafts
- Proposal acceptance always precedes agreement
- Proposal stage introduces scope, not rules

---

## UX Principles

- One decision at a time
- No legal language before agreement
- No access requests before onboarding
- Proposal should feel informative, not binding

---

## Summary

The Proposal stage exists to:
- Align on scope and pricing
- Create shared understanding
- Set up a smooth transition to agreement

It should feel:
- Low-pressure
- Clear
- Professional
- Easy to revise before sending