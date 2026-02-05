# Expense Detail Modal Design

**Date:** 2026-02-05
**Status:** Approved

## Problem

The expenses table currently uses inline editing like time entries, but expenses have more fields (vendor, status, category, receipt, etc.) making inline editing cramped. Additionally, expenses support comments/discussion which need a dedicated space.

## Solution

Two-tier interaction pattern:

1. **Row-level quick edits** - For the most common single-field changes
2. **Detail modal** - For full viewing, editing, and discussion

---

## Layer 1: Row-Level Inline Controls

Each expense row shows quick-edit controls for common operations without opening the modal.

| Field | Control Type | Behavior |
|-------|-------------|----------|
| **Category** | Click → dropdown | Shows category options, saves immediately on selection |
| **Client/Project** | Click → cascading dropdown | Client first, then project filtered by client |
| **Price** | Click → inline input | Shows input with blur/enter to save |
| **Billable** | Toggle checkbox | Instant toggle, saves immediately |
| **Duplicate** | Icon button | Creates copy with today's date, opens modal for new expense |

### Row Click Behavior

- Clicking the row (outside inline control areas) opens the detail modal
- Inline controls intercept clicks on their specific fields
- Visual affordance: subtle hover states on editable fields

---

## Layer 2: Detail Modal

### Layout

Two-column layout (~800px total width):
- **Left (2/3)**: Expense details (view or edit mode)
- **Right (1/3)**: Comments/discussion thread

### View Mode (Default)

Compact, scannable summary:

```
┌────────────────────────────────────────┬───────────────────────┐
│                                        │                       │
│  $149.00 · Adobe Creative Cloud        │  Comments             │
│  Software · Acme Corp / Website        │                       │
│  Jan 15, 2026 · Paid                   │  [Thread of comments] │
│                                        │                       │
│  Receipt: invoice.pdf [view]           │                       │
│                                        │                       │
│  [Edit]                                │  [Add comment...]     │
│                                        │                       │
└────────────────────────────────────────┴───────────────────────┘
```

View mode shows:
- Amount and description (prominent)
- Category, client/project path
- Date and payment status
- Receipt attachment (if any)
- Edit button to switch to edit mode

### Edit Mode

Full form with all fields:

```
┌────────────────────────────────────────┬───────────────────────┐
│                                        │                       │
│  Description: [Adobe Creative Cloud]   │  Comments             │
│  Amount: [$149.00]                     │                       │
│  Category: [Software ▼]                │  [Thread of comments] │
│  Client: [Acme Corp ▼]                 │                       │
│  Project: [Website ▼]                  │                       │
│  Date: [Jan 15, 2026]                  │                       │
│  Vendor: [Adobe]                       │                       │
│  Status: [Paid ▼]                      │                       │
│  Billable: [✓]                         │                       │
│  Receipt: [invoice.pdf] [Upload]       │                       │
│                                        │                       │
│  [Cancel] [Save]                       │  [Add comment...]     │
│                                        │                       │
└────────────────────────────────────────┴───────────────────────┘
```

### Transition Behavior

- **View → Edit**: In-place transform of left panel only
- **Edit → View**: On save or cancel, returns to view mode
- **Comments panel**: Unchanged during transition
- **Animation**: Subtle crossfade, no jarring layout shift

---

## Comments Panel

Uses existing `ExpenseComments` component with minor layout adjustments:
- Vertically scrollable thread
- Newest at bottom (chat-style)
- Input fixed at bottom of panel
- Shows comment count in expense row for quick reference

---

## Design Principles

1. **Progressive disclosure** - Quick edits in row, full detail in modal
2. **Context preservation** - Discussion visible alongside details
3. **View-first** - Default to viewing, explicit action to edit
4. **Instant saves** - Row-level edits save immediately (no confirm)
5. **Modal saves** - Full form requires explicit save action

---

## Implementation Notes

### New Components

- `ExpenseDetailModal` - Main modal wrapper with two-column layout
- `ExpenseDetailView` - Compact view mode content
- `ExpenseDetailEdit` - Full edit form (similar to current dialog)
- Row inline edit components (category selector, price input, etc.)

### Reuse Existing

- `ExpenseComments` - Already exists, minor styling adjustments
- `ExpenseCommentCount` - Already shows count in rows
- Form validation logic from `ExpenseDialog`

### State Management

- Modal open state controlled by parent (expenses page)
- View/edit mode state internal to modal
- Optimistic updates for row-level quick edits
- Form state for modal edit mode

---

## Open Questions

None at this time. Design approved.
