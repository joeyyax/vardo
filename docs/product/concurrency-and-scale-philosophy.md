# Concurrency & Scale Philosophy

This document defines how the system supports multiple simultaneous projects without becoming complex or enterprise-oriented.

---

## Supported Scale

This system is designed for:
- Freelancers
- Small studios
- Boutique agencies (2–20 people)

It supports:
- Multiple concurrent projects per client
- Multiple concurrent projects per team member
- Clear isolation between projects

---

## What Scales Well

- Clients with multiple active projects
- Ongoing retainers alongside fixed-scope projects
- Parallel work with different timelines
- Small teams collaborating across projects

Each project:
- Has its own lifecycle
- Has its own state
- Has its own scope and rules

---

## What Is Intentionally Out of Scope

The system does not support:
- Nested projects
- Sub-project hierarchies
- Cross-project state dependencies
- Partial agreements or hybrid scopes
- Parallel lifecycles inside a single project

If work diverges significantly, it becomes a new project.

---

## Mental Model

**One project = one journey.**

Concurrency is handled by having multiple journeys, not by complicating a single one.

---

## Summary

This system scales by:
- Repetition
- Isolation
- Clarity

Not by abstraction or hierarchy.