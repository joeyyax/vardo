# Bug Reporting Intake

This document defines the on-site bug reporting feature and how it integrates into the system.

The goal is to make issue reporting effortless for clients while producing high-quality, structured input for the provider.

---

## Purpose

Bug reporting exists to:
- Reduce friction for clients reporting issues
- Capture better debugging context automatically
- Route issues into the existing request intake flow
- Prevent bug reports from becoming unmanaged work

This feature is an intake mechanism — not a workflow system.

---

## What This Feature Is

- A lightweight JavaScript embed
- Runs on client sites
- Activated only for authenticated users
- Allows clients to visually point to an issue
- Creates a structured request in the system

---

## What This Feature Is Not

- A project management tool
- A standalone bug tracker
- A replacement for tasks or projects
- A place where work starts automatically

All submitted issues must be triaged.

---

## High-Level Flow

1. Client clicks “Report an issue”
2. Page enters inspect mode
3. Client selects a page element
4. Client adds a short description
5. Issue is submitted
6. System creates a request (not an active task)

Provider reviews and decides next steps.

---

## Internal Result

Each submission creates:
- A request in `requested` / `needs-review` state
- Linked to:
  - client
  - project
  - page URL
  - reporting user
- With attached environment metadata

No task is created automatically.

---

## Triage Outcomes

Provider may:
1. Accept as a task
2. Ask a clarifying question
3. Convert to a new project
4. Defer or decline

This preserves scope and priority control.

---

## Summary

Bug reporting lowers friction at the edges without weakening the core workflow.

It captures intent, not authority.