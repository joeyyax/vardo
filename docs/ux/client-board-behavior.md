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

## Client-Facing Copy Reference

Use this language in the portal and help text:

> The task board shows progress at a glance. You'll see what's planned, what's in progress, what's waiting, and what's complete.
>
> You can comment on tasks, answer questions, upload files, and request new work. If something needs attention, commenting is the fastest way to flag it.
>
> Task status is managed by the team so priorities stay clear and consistent. You never need to move tasks yourself.

---

## Summary

The board is a shared window into work — not a shared control panel.