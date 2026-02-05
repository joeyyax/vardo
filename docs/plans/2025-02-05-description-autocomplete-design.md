# Description Autocomplete for Entry Bar

## Overview

Add autocomplete to the description input that searches past entries and pre-fills the form when a suggestion is selected. Goal: reduce friction for repetitive tasks.

## Behavior

1. User types in description field
2. After 200ms debounce, search past entry descriptions
3. Show dropdown with matches (description + client/project context + duration)
4. Arrow keys navigate, Enter selects, Escape closes
5. On select: pre-fill description, client/project/task, duration
6. Focus stays on description field
7. Tab to adjust fields, Cmd+Enter to save

## API

**Endpoint:** `GET /api/v1/organizations/[orgId]/entry-suggestions`

**Query params:**
- `query` (required) - description search text
- `clientId` (optional) - filter to specific client
- `projectId` (optional) - filter to specific project

**Response:**
```json
{
  "suggestions": [
    {
      "description": "Weekly standup with team",
      "client": { "id": "uuid", "name": "Acme", "color": "#3b82f6" },
      "project": { "id": "uuid", "name": "Retainer", "code": "RET" } | null,
      "task": { "id": "uuid", "name": "Meetings" } | null,
      "durationMinutes": 15,
      "usageCount": 12
    }
  ]
}
```

**Backend logic:**
1. Query `time_entries` from last 60 days for user/org
2. Filter where `description ILIKE %query%`
3. Group by description + clientId + projectId + taskId
4. For each group: calculate most common duration (mode)
5. Order by usageCount desc, most recent desc
6. Limit to 10 results

## Component Changes

**File:** `components/layout/entry-bar.tsx`

**New state:**
- `descriptionSuggestions: DescriptionSuggestion[]`
- `descriptionDropdownOpen: boolean`
- `highlightedIndex: number`

**New refs:**
- `dropdownRef` for click-outside handling

**Description input changes:**
- Add `onKeyDown` for arrow/enter/escape handling
- Show dropdown when suggestions exist and input focused

**On suggestion select:**
- Set description text
- Set selectedItem (client/project/task)
- Set durationMinutes and durationInput
- Keep dropdown closed, focus on description

## Files to Create/Modify

1. `app/api/v1/organizations/[orgId]/entry-suggestions/route.ts` (new)
2. `components/layout/entry-bar.tsx` (modify)

## Out of Scope

- Fuzzy matching (simple ILIKE is sufficient)
- Separate suggestion component extraction (keep inline for now)
- SmartEntryBar changes (may remove later)
