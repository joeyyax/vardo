# Progressive Search & Selection

Scope uses **progressive disclosure** for search and selection across the app.

This applies to:
- the predictive “What did you work on?” entry
- client / project / task selectors
- search-driven pickers throughout the UI

The goal is to keep interactions fast, calm, and predictable — even as data grows.

---

## Core Principle

> Show the most relevant, active items first.  
> Expand the search space only with explicit user intent.

Nothing disappears unexpectedly.  
Nothing appears unless the user asks for it.

---

## Default Search Behavior

By default, search and selectors operate on a **focused, hot dataset**:

- Only **Active** clients, projects, and tasks
- Ranked by **recent activity**
- Optimized for speed and clarity

This covers the majority of real-world usage:
- current clients
- ongoing projects
- recent work

Search results should feel instant and unsurprising.

---

## Progressive Expansion

When no results are found — or when results are limited — Scope offers a gentle expansion path instead of widening the search automatically.

Example UI copy:

> No active projects match your search.  
> **Continue searching archived projects**

Key characteristics:
- Expansion is **opt-in**
- Language explains *why* results are limited
- The user remains in control

Archived or inactive items are never shown implicitly.

---

## Archived & Inactive Items

When expanded:
- Archived items appear **after** active results
- They are clearly labeled (e.g. “Archived”)
- Visual treatment is muted, not alarming

Archived items:
- are searchable
- are never deleted
- are never hidden without explanation

Archiving represents closure, not loss.

---

## Why This Matters

### UX
- Prevents clutter in everyday workflows
- Avoids “where did my project go?” moments
- Teaches lifecycle naturally, without documentation

### Performance
- Keeps default searches extremely fast
- Reduces query size and index pressure
- Allows cold data (archived items) to live on a slower path

### Trust
- No surprise automation
- No hidden filters
- No guessing user intent

---

## Where This Pattern Is Used

This behavior applies consistently across:

- Time entry suggestions (“What did you work on?”)
- Client selector
- Project selector
- Task selector
- Link / assignment dialogs

Anywhere the user is *selecting* something, not browsing exhaustively.

---

## Where It Does NOT Apply

This pattern is intentionally **not** used in:

- Reports (explicit filters are required)
- Dashboards (defaults are stable and visible)
- Settings (no hidden state)

Search expansion is contextual, not global.

---

## Design Constraints

To preserve clarity:

- No automatic expansion
- No global “include archived” setting
- No remembered preference between searches
- No silent behavior changes

Each search interaction is self-contained and reversible.

---

## Summary

Progressive search keeps Scope fast, calm, and predictable.

It scales with real usage, respects user intent, and avoids clever behavior that erodes trust.

Search should feel like assistance — not inference.