# On-Site Overlay Philosophy

This document defines the design constraints for any on-site overlay features.

---

## Core Principles

- Invisible until needed
- Minimal UI
- No configuration required
- Zero cognitive load
- No independent state or workflow

The overlay should feel like a temporary tool, not a permanent interface.

---

## Activation Rules

The overlay:
- Loads only when explicitly enabled
- Appears only for authenticated users
- Is hidden from public visitors
- Never interferes with normal site usage

---

## UI Behavior

- Hover highlights elements
- Click selects an element
- A small panel appears for input
- One primary action: submit

No dashboards. No lists. No settings.

---

## Data Capture Philosophy

Clients describe the problem.
The system captures the context.

Clients should never be asked for:
- Browser info
- Screen size
- URLs
- Technical details

Those are captured automatically.

---

## Summary

The overlay exists to disappear quickly and leave behind high-quality signal.