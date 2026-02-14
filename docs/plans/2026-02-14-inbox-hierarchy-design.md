# Inbox Hierarchy Design (My Work Phase 3)

## Summary

Surface inbox items on project and client dashboards with scoped filtering, and support downward reassignment of items through the entity hierarchy. Full triage stays at `/inbox`; dashboards get compact, read-only previews with count badges.

## Decisions

- **Dashboard UX:** Count badge in collapsible section header + compact item list. Full triage at `/inbox`.
- **Scope rollup:** Client inbox shows its own items + all items from that client's projects (trickle-up).
- **Reassignment:** Down only. Org → client, org → project, client → project. No moving back up.
- **Component strategy:** One shared `EntityInboxSection` component used on both project and client dashboards, differentiated by filter props.

## API Changes

### Inbox List API

`GET /api/v1/organizations/[orgId]/inbox`

Add optional query params:

| Param | Behavior |
|-------|----------|
| `clientId` | Items where `clientId = X` OR `projectId` belongs to that client (trickle-up) |
| `projectId` | Items where `projectId = X` |
| `limit` | Cap results (default: all, dashboard passes `limit=5`) |

These stack with the existing `status` param.

### Inbox Item PATCH API

`PATCH /api/v1/organizations/[orgId]/inbox/[itemId]`

Extend beyond `status` to accept:

| Field | Validation |
|-------|-----------|
| `clientId` | Can set if currently null. Cannot clear. |
| `projectId` | Can set if currently null or only has clientId. Auto-sets clientId from project's parent client. Cannot clear. |

Down-only enforcement: server rejects any attempt to widen scope.

## New Component

### `EntityInboxSection`

Self-contained, compact inbox preview for entity dashboards.

**Props:** `orgId`, `entityType: "project" | "client"`, `entityId`, `entityName`

**Behavior:**
- Fetches `GET /inbox?projectId=X&status=needs_review&limit=5` or `?clientId=X&...`
- Collapsible section with count badge in header: "Inbox (3)"
- Collapsed by default if count is 0, open if items exist
- Compact item rows: sender, subject, time ago
- Client view: rows show which project the item belongs to (or "Client-level" if no project)
- "View all" link navigates to `/inbox?projectId=X` or `/inbox?clientId=X`
- No conversion actions inline — clicking an item navigates to `/inbox?item=X` for full triage

## Dashboard Integration

### Project Dashboard

- Add `EntityInboxSection` after Files section, before Expenses
- Add `IntakeEmailPopover` to header action buttons (existing component, pass `projectId`)
- Gate behind `features.expenses`

### Client Dashboard

- Add `EntityInboxSection` in same relative position
- No `IntakeEmailPopover` for clients (no client intake token API yet — future work)
- Gate behind `features.expenses`

## Transfer Form Changes

Extend `inbox-transfer-form.tsx` with conditional rendering based on current item scope:

| Current Scope | Available Actions |
|--------------|-------------------|
| No scope (org-level) | Show client selector + project selector. Picking project auto-sets client. |
| Has client, no project | Show project selector filtered to that client's projects. |
| Has project | Transfer not available (already at most specific scope). |

No new components — smarter conditional rendering in the existing form.

## Files Changed

| File | Change |
|------|--------|
| `app/api/v1/organizations/[orgId]/inbox/route.ts` | Add `clientId`, `projectId`, `limit` query params |
| `app/api/v1/organizations/[orgId]/inbox/[itemId]/route.ts` | Extend PATCH for reassignment fields |
| `components/inbox/entity-inbox-section.tsx` | New — compact inbox preview component |
| `app/(app)/projects/[id]/project-dashboard.tsx` | Add `EntityInboxSection` + `IntakeEmailPopover` |
| `app/(app)/clients/[id]/client-dashboard.tsx` | Add `EntityInboxSection` |
| `components/inbox/inbox-transfer-form.tsx` | Conditional scope-based reassignment UI |

## What's NOT Changing

- `/inbox` page and `inbox-content.tsx` — org-level triage stays as-is
- `inbox-item-detail.tsx` — detail modal and conversion actions unchanged
- Schema — `clientId`, `projectId`, `assignedTo` already exist with indexes
