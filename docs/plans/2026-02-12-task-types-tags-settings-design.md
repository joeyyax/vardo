# Design: Task Types & Tags Settings UI

## Overview

Add inline management UI for task types and task tags on the settings page. Both have schema and partial API support — this adds the missing CRUD endpoints and settings UI.

## Decisions

- **Inline on settings page** (not a dedicated subpage) — small lists, infrequent edits
- **Task types**: name + color + position only (icon and defaultFields deferred)
- **Task tags**: support both predefined (settings) and ad-hoc (created in task dialog)
- **Editable table rows** — compact list, consistent with settings page patterns

## Task Types Management

**Location**: New "Tasks" section on settings page, below Features, gated behind `features.pm`.

**UI**: Compact list with:
- Drag handle for reordering (updates `position`)
- Color dot + name
- Edit button → small dialog with name input + color picker (preset palette)
- Archive button (toggles `isArchived`, dims the row)
- "Add Type" button at top

**Behavior**:
- Drag-and-drop updates position via batch PATCH
- Archive instead of delete (types may be referenced by existing tasks)
- Archived types hidden by default, toggle to show
- New types get position = max + 1

## Task Tags Management

**Location**: Same "Tasks" section, below task types with a subtle divider.

**UI**: Simple list (no drag handles — tags don't need ordering):
- Color dot + name + "ad-hoc" badge if `isPredefined === false`
- Edit button → same small dialog (name + color)
- Delete button with confirmation (cascades tag assignments)
- "Add Tag" button at top

**Behavior**:
- Ad-hoc tags appear with badge, can be promoted to predefined via edit
- Delete removes tag and all task assignments (schema cascade)

## API Changes

New endpoints:
- `PATCH /api/v1/organizations/[orgId]/task-types/[typeId]` — update name, color, position, isArchived
- `DELETE /api/v1/organizations/[orgId]/task-types/[typeId]` — hard delete (reject if tasks reference it, suggest archive)
- `PATCH /api/v1/organizations/[orgId]/task-tags/[tagId]` — update name, color, isPredefined
- `DELETE /api/v1/organizations/[orgId]/task-tags/[tagId]` — hard delete (cascades)
- `PATCH /api/v1/organizations/[orgId]/task-types/reorder` — batch position update for drag-and-drop

## Settings Page Layout

```
[existing sections...]
Features Form
─────────────────────
Tasks                          ← new section, PM-gated
  Task Types
    [drag] 🔴 Bug         [edit] [archive]
    [drag] 🟢 Feature     [edit] [archive]
    [drag] 🔵 Chore       [edit] [archive]
    [+ Add Type]

  Task Tags
    🟣 urgent                   [edit] [delete]
    🟡 blocked                  [edit] [delete]
    🟠 needs-review  (ad-hoc)   [edit] [delete]
    [+ Add Tag]
─────────────────────
Document Templates
[remaining sections...]
```
