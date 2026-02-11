# Client Board Behavior

This document defines how the task board behaves for clients.

The board is designed for visibility and collaboration, not workflow control.

---

## Client View of the Board

Clients see:
- A Kanban-style board
- Tasks grouped by status
- Clear indicators of progress and blockers

The board answers:
- What’s planned?
- What’s in progress?
- What’s waiting?
- What’s done?

---

## Allowed Client Actions

Clients can:
- Open any visible task
- Read descriptions and context
- Comment on tasks
- Upload files (if enabled)
- Submit new task requests
- Approve or review work when requested

---

## Disallowed Client Actions

Clients cannot:
- Drag tasks between columns
- Change task status
- Reorder tasks
- Mark tasks complete

If a client attempts to interact with these controls, the UI should:
- Do nothing, or
- Show a gentle explanation

Example helper copy:
> “Task status is managed by the team. Feel free to comment if something needs attention.”

---

## Rationale

Most clients want insight, not responsibility.

This model:
- Reduces confusion
- Prevents accidental scope changes
- Keeps priorities stable
- Scales to small teams cleanly

---

## Summary

The board is a shared window into work — not a shared control panel.