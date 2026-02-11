# Client & Project Entry UX

This document describes the user experience for creating clients and starting projects.

It covers:
- Client creation
- Client overview (no project yet)
- Starting a new project

This flow applies to both first-time and repeat clients.

---

## Goals

- Make the distinction between Clients and Projects obvious
- Avoid implying work exists before it does
- Keep early steps lightweight and non-committal
- Create a clear, intentional starting point for each project

---

## Clients List

### What the user sees

A list of existing clients with:
- Client name
- Number of projects
- Quick indicator of active work (if any)

Primary action:
- **Add client**

Secondary actions:
- Search
- Filter

---

## Add Client

### Purpose

Create a client record without starting work.

This step should feel safe and reversible.

### Required fields

- Client name

### Optional fields

- One contact (often the person who reached out)
- Internal notes

No project is created at this stage.

---

## After Client Creation

### Navigation

After saving, the user is taken to the **Client Overview** page.

---

## Client Overview (No Projects Yet)

### Purpose

Answer the question:
> “What’s going on with this client?”

For a new client, the honest answer is:
> “Nothing yet.”

### What the user sees

- Client name
- Contacts (if any)
- Projects section showing:
  > No projects yet

Primary action:
- **Start a new project**

Secondary actions:
- Add or edit contacts
- Add internal notes

No lifecycle status is shown at the client level.

---

## Start New Project

### Purpose

This is the true kickoff point.

Starting a project creates:
- A project record
- A lifecycle
- A dashboard
- A place for documents and tasks

### Required fields

- Project name
- Primary contact  
  (pre-filled from client contacts if available)

### Optional fields

- Internal notes

No scope, pricing, or commitments are required here.

---

## After Project Creation

### Project State

- Project enters **Getting Started**
- Lifecycle timeline becomes visible
- Orientation content appears

### What the user sees

Status:
> **Getting Started**  
> We’re setting things up and aligning on next steps.

Visible elements:
- Lifecycle timeline (future steps visible but locked)
- “How We’ll Work Together” document
- One primary action:
  - **Create proposal**

No proposal, agreement, onboarding, or tasks exist yet.

---

## Key UX Principles

- Creating a client ≠ starting work
- Creating a project ≠ committing to scope
- The system should never fake progress
- Each screen should answer one clear question

---

## Summary

This entry flow ensures:
- Clients and projects are clearly separated
- New clients don’t feel prematurely “active”
- Every project has a deliberate start
- The proposal stage feels earned, not rushed