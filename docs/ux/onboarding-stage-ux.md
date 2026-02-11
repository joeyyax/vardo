# Onboarding Stage UX

This document defines the user experience for onboarding a project after the agreement has been accepted.

The Onboarding stage exists to gather access, refine information, and prepare the project for active work.
It should feel structured, justified, and collaborative — not bureaucratic.

---

## Entry Point

### When this stage begins

- Agreement has been accepted
- Project state advances to **Onboarding**

Onboarding content is generated automatically based on:
- Proposal type
- Hosting selection
- Existing client data

---

## Project Page — Onboarding Stage

### Status

> **Onboarding**  
> We’re gathering access and setting things up.

### Visible Elements

- Lifecycle timeline
  - Agreement (completed)
  - Onboarding (current)
  - Active (locked)

- Onboarding checklist
- Short explanation of purpose:
  > *These items help us get set up so work can begin smoothly.*

---

## Onboarding Checklist

### Characteristics

- Checklist is ordered, but not strictly linear
- Each item explains *why* it exists
- Items may be:
  - Required
  - Optional
  - Contextual (only shown when relevant)

Checklist completion is the only way to advance to **Active**.

---

## Example Checklist Items

### 1. Confirm Project Contacts

**Purpose**
Ensure the right people are looped in.

**UX**
- Show existing contacts and roles
- Allow client to:
  - Add contacts
  - Assign multiple roles
  - Leave roles unset
  - Indicate “not applicable”

This step never blocks onboarding.

---

### 2. Provide Access

Shown only when relevant.

Examples:
- CMS access
- Repository access
- Hosting provider access
- Domain / DNS access

**UX**
- Each access request explains why it’s needed
- Credentials are submitted securely
- “We’ll request this later” is allowed where possible

---

### 3. Hosting Setup (If Applicable)

Shown only if hosting was selected.

**UX**
- Confirm hosting scope
- Confirm storage ownership (e.g. S3 / R2)
- Acknowledge:
  - No SSH / FTP access
  - Managed environment
  - Data ownership

This is confirmation, not configuration.

---

### 4. Project Inputs

Examples:
- Content readiness
- Brand assets
- External dependencies

These may be:
- Uploaded
- Linked
- Deferred with notes

---

### 5. Final Review

A lightweight confirmation step.

**UX Copy**
> *Once these items are complete, we’ll begin active work.*

Primary action:
- **Mark onboarding complete**

---

## Completing Onboarding


### Completing Onboarding

Clients can complete onboarding checklist items as they’re ready.

Once all required items are complete, the Provider will review everything and mark onboarding complete, which starts active work on the project.

### When onboarding is marked complete

System behavior:
- Project state advances to **Active**
- “Work is underway” email is sent
- Initial tasks are created (if applicable)
- Onboarding checklist becomes read-only
- Checklist is saved to Project Docs

---

## Client Experience Principles

- Every request has a reason
- Nothing feels arbitrary
- Missing info does not feel like failure
- Progress is visible as items are completed

Clients should feel:
> “This is organized, and I know why I’m being asked for this.”

---

## UX Constraints

- Onboarding cannot begin before agreement acceptance
- Active work cannot begin before onboarding completion
- Checklist items are additive, not destructive
- Onboarding state is explicit and visible at all times

---

## Summary

The Onboarding stage:
- Turns agreements into action
- Refines imperfect information
- Prepares the system and the client for real work

It should feel like a calm, structured handoff — not a gatekeeper.