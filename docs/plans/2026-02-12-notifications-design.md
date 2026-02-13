# Design: Notifications System (Phase 11)

## Overview

Complete the notification system with watch/unwatch UI, notification history page, email delivery for all types, and daily digest option. Built in 4 independent layers that each deliver value on their own.

## What Already Exists

- Notifications table with 7 types (assigned, mentioned, status_changed, comment, blocker_resolved, client_comment, edit_requested)
- Notification preferences table (5 type toggles + emailEnabled)
- Full CRUD API for notifications and preferences
- Notification bell with dropdown (60s polling, 10 items, mark as read)
- Task-scoped notification helpers (assignment, status change, comment, blocker resolved)
- Watcher tables for all entities (tasks, projects, expenses, clients, contacts, invoices, documents)
- Auto-subscription for commenters
- Resend email integration with fire-and-forget pattern
- Task assignment email template

## Scope

- Watch/unwatch for: tasks, projects, expenses
- Email for all notification types (immediate + daily digest)
- Notification history page with filters

## Layer 1: Watch/Unwatch

### API Endpoints

Same pattern for tasks, projects, expenses:

- `GET .../watchers` — list watchers with `isWatching` flag for current user
- `POST .../watchers` — add self as watcher (reason: `manual`)
- `DELETE .../watchers` — remove self as watcher

Concrete routes:
- `/api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/watchers`
- `/api/v1/organizations/[orgId]/projects/[projectId]/watchers`
- `/api/v1/organizations/[orgId]/expenses/[expenseId]/watchers`

### Auto-Subscription Expansion

- Task creation: auto-subscribe creator (reason: `creator`)
- Task assignment: auto-subscribe assignee (reason: `assignee`)
- Hook into existing POST/PATCH task routes

### UI: WatchButton Component

Reusable component:
```tsx
<WatchButton entityType="task" entityId={id} orgId={orgId} projectId={projectId} />
```

- Shows "Watch" (Eye icon) or "Watching" (EyeOff icon) toggle
- Placed in sticky header of two-panel detail modals
- Tooltip shows watcher count

### Watcher List

Small section in discussion sidebar showing who's watching and why (creator, assignee, commenter, manual).

## Layer 2: Notification History Page

### Route

`/notifications` in the `(app)` route group.

### Layout

- Page header: "Notifications"
- Toolbar: type filter dropdown (All, Assignments, Comments, Status Changes, etc.) + "Mark all read" button
- Paginated list — full-width notification rows with: icon (by type), actor name, content, timestamp, read/unread dot, click navigates to entity
- Infinite scroll or "Load more" at bottom
- Empty state: "No notifications yet."

### API Changes

Add `type` filter param to existing `GET /api/v1/notifications`.

### Sidebar Nav

Add "Notifications" link (Bell icon) with unread badge count.

## Layer 3: Email Templates & Delivery

### Template

Single reusable `NotificationEmail` template (React Email, matches existing LifecycleEmail style):
- Subject varies by type: "You were assigned to [task]", "[Actor] commented on [task]", etc.
- Body: actor info, description of what happened, "View in app" button
- One parameterized template, not one per type

### Wiring

In `createNotification` (lib/notifications.ts):
- After inserting notification, check `emailEnabled` preference
- If enabled and `emailDelivery === 'immediate'`, send email fire-and-forget
- If `emailDelivery === 'daily'`, skip (digest cron handles it)
- Mark `emailSent: true` after sending

Existing helpers (notifyTaskWatchers, notifyAssignment, etc.) already call createNotification, so email delivery is automatic once wired.

## Layer 4: Daily Digest

### Schema Change

Add to `notificationPreferences`:
```
emailDelivery: text('email_delivery').default('immediate')
```
Values: `'immediate'` or `'daily'`

### Preferences UI Update

When `emailEnabled` is on, show select: "Immediate" or "Daily digest".

### Digest Email Template

`DigestEmail` — groups unread notifications by type:
- Subject: "You have X new notifications"
- Body: grouped sections with summary lines and "View all" link
- Only sent if there are unsent notifications

### Cron Endpoint

`POST /api/cron/send-notification-digest`:
- Query notifications where `emailSent = false` and user's `emailDelivery = 'daily'`
- Group by user, render digest, send via Resend
- Mark included notifications as `emailSent: true`
- Called daily by external scheduler
