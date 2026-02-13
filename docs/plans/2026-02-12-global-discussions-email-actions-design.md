# Global Discussions & Entity Email Actions — Design

## Goal

Surface discussions as a top-level action on project and client dashboards (not buried in detail modals), and expand inbox email conversions beyond expenses to support files, discussions, tasks, and transfers.

## Architecture

Two changes that share the theme of "making existing capabilities more accessible":

1. **Discussions slide-over** — A `Sheet` component triggered from the dashboard action bar, wrapping the existing `EntityComments` component. No new data model or APIs.
2. **Email conversion actions** — Extend inbox item conversion to support five target types (file, discussion, expense, task, transfer) with a type selector and per-type forms.

## Decisions

- **Slide-over (Sheet)** chosen over persistent sidebar or dedicated page. Minimal layout changes, familiar overlay pattern.
- **Dashboard entities only** — Projects and clients get the discussions button. Tasks, expenses, invoices, documents, and contacts keep discussions in their existing detail modals.
- **Unified timeline** — The slide-over shows comments + activities (same as modal sidebar), not comments only.
- **Task conversion** supports both "create new" and "attach to existing" sub-options.

---

## Part 1: Discussions Slide-Over

### What changes

Project and client dashboards get a `MessageSquare` icon button in the action bar (next to Edit, New Task, etc.). Clicking it opens a `Sheet` sliding in from the right containing the entity's discussion timeline.

### New component

**`components/ui/discussion-sheet.tsx`**

Wraps `Sheet` + `SheetContent` around the entity-specific comments component (`ProjectComments` or `ClientComments`). Props:

```typescript
type DiscussionSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "project" | "client";
  entityId: string;
  orgId: string;
  currentUserId: string;
  onUpdate?: () => void;
};
```

- Renders `ProjectComments` or `ClientComments` based on `entityType`
- Sheet width: override default `sm:max-w-sm` to `sm:max-w-md`
- Header shows "Discussion" title with entity name

### Dashboard changes

**`app/(app)/projects/[id]/project-dashboard.tsx`**
- Add `MessageSquare` icon button to action bar (right section, before Edit)
- State: `discussionOpen` boolean
- Render `DiscussionSheet` with `entityType="project"`

**`app/(app)/clients/[id]/client-dashboard.tsx`**
- Same pattern with `entityType="client"`

### No data model changes

Comments, activities, watchers, notifications, and event bus wiring all exist. This is purely UI.

---

## Part 2: Entity Email Conversion Actions

### Conversion types

| Type | Description |
|------|-------------|
| **File** | Link inbox item files to the entity's file list |
| **Discussion** | Post email content as a comment on the associated project/client |
| **Expense** | Create an expense (existing behavior) |
| **Task (new)** | Create a new task on the project |
| **Task (attach)** | Attach files/content to an existing task |
| **Transfer** | Reassign inbox item to a different project/client |

### Schema change

Add to `inbox_items` table:
- `convertedTo` (text, nullable): `'expense' | 'file' | 'discussion' | 'task' | 'transfer'`

### UI changes

**`components/inbox/inbox-item-detail.tsx`**
- Replace "Convert to Expense" button with a "Convert to..." dropdown selector
- Selection swaps in the appropriate form component
- Only show conversion options when item status is not already `converted`
- Show `convertedTo` badge on already-converted items

### New form components

**`components/inbox/inbox-convert-file-form.tsx`**
- Simple confirmation: shows which files will be linked
- Calls `POST .../inbox/{id}/convert-file`

**`components/inbox/inbox-convert-discussion-form.tsx`**
- Text area pre-filled with email subject + body excerpt
- Optional: choose comment visibility (shared/internal)
- Calls `POST .../inbox/{id}/convert-discussion`

**`components/inbox/inbox-convert-task-form.tsx`**
- Toggle: "Create new" / "Attach to existing"
- Create new: task name (pre-filled from subject), description, project pre-selected
- Attach to existing: `TaskSelector` to pick task, files get attached
- Calls `POST .../inbox/{id}/convert-task`

**`components/inbox/inbox-transfer-form.tsx`**
- Project and/or client selector to reassign the inbox item
- Calls `PATCH .../inbox/{id}` to update `clientId`/`projectId`
- Does NOT mark as converted (item is still pending in new location)

### New API endpoints

All under `/api/v1/organizations/[orgId]/inbox/[itemId]/`:

| Endpoint | Method | Action |
|----------|--------|--------|
| `convert-file` | POST | Copy inbox files to entity files, mark converted |
| `convert-discussion` | POST | Create comment on entity, mark converted |
| `convert-task` | POST | Create task or attach to existing, mark converted |
| `convert` | POST | Expense conversion (existing, unchanged) |

Transfer uses existing PATCH on the inbox item (no new route).

All conversion endpoints:
1. Perform the conversion action
2. Set `status: 'converted'` and `convertedTo` on the inbox item
3. Return the created entity ID

---

## Files Summary

| File | Action |
|------|--------|
| `components/ui/discussion-sheet.tsx` | Create |
| `app/(app)/projects/[id]/project-dashboard.tsx` | Modify — add Discussions button |
| `app/(app)/clients/[id]/client-dashboard.tsx` | Modify — add Discussions button |
| `components/inbox/inbox-item-detail.tsx` | Modify — conversion type selector |
| `components/inbox/inbox-convert-task-form.tsx` | Create |
| `components/inbox/inbox-convert-discussion-form.tsx` | Create |
| `components/inbox/inbox-convert-file-form.tsx` | Create |
| `components/inbox/inbox-transfer-form.tsx` | Create |
| `app/api/v1/organizations/[orgId]/inbox/[itemId]/convert-file/route.ts` | Create |
| `app/api/v1/organizations/[orgId]/inbox/[itemId]/convert-discussion/route.ts` | Create |
| `app/api/v1/organizations/[orgId]/inbox/[itemId]/convert-task/route.ts` | Create |
| `lib/db/schema.ts` | Modify — add `convertedTo` to inbox_items |
