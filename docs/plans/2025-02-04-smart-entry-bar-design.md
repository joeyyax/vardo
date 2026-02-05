# Smart Entry Bar Design

## Overview

Modernize the time entry experience with a unified natural language input. Users type naturally and the system recognizes clients, projects, tasks, durations, and dates without requiring special syntax.

The current entry bar remains available. Users toggle between "classic" (separate fields) and "smart" (unified input) modes via an inline button.

Additionally, recurring entry suggestions move from a separate section at the top to inline within the day's entry list.

---

## Smart Entry Bar

### Core Interaction

1. User types naturally: `Acme homepage updates 2h`
2. Always-visible dropdown shows matches, narrowing in real-time
3. Arrow keys navigate suggestions, Tab or click locks in a selection
4. Locked selections become chips: `[Acme Corp]` `[Homepage Redesign]` homepage updates `[2h]`
5. Remaining text becomes the description
6. No date = today (or type "yesterday", "monday", etc.)

### What Gets Recognized

| Pattern | Examples | Behavior |
|---------|----------|----------|
| Duration | `2h`, `1.5h`, `90m`, `1:30`, `2` | Chip, rounds to increment |
| Client/Project/Task | Names matching existing entities | Dropdown suggestion, chip on select |
| Relative dates | `yesterday`, `monday`, `last friday` | Date chip |
| Specific dates | `jan 15`, `1/15`, `2025-01-15` | Date chip |

### Parsing Intelligence

Multiple signals combine to avoid overeager matching:

1. **Position bias** - Words at the start weight toward entity matching. Words after chips lean toward description.

2. **Confidence threshold** - Only suggest matches with strong similarity. Partial matches don't aggressively match mid-sentence.

3. **Phrase detection** - Patterns like "meeting with", "call about", "working on" signal description context.

4. **Selection confirms intent** - Nothing becomes a chip automatically. User must Tab/click to confirm.

### Minimum Required

- Client (chip)
- Duration (chip)

Everything else optional. Date defaults to today.

### Visual Design

**Input field:**
- Single text input, expands slightly on focus
- Chips render inline (like email To fields)
- Client chip uses client's color; duration/date chips are neutral
- Backspace next to chip removes it
- Placeholder: "What did you work on?"

**Suggestions dropdown:**
- Always visible when input focused
- 5-7 suggestions max, scrollable
- Shows: color dot, name, context ("Client" or "Project under Acme")
- Section headers when mixing types
- Highlighted row follows arrow navigation

**Mode toggle:**
- Small icon at end of entry bar
- Toggles between classic and smart modes
- Tooltip explains the modes

**Add button:**
- Disabled/muted when missing client or duration
- Becomes active when ready to submit
- Visual indicator that you can now submit

### Keyboard Shortcuts

- **Arrow Up/Down** - Navigate suggestions
- **Tab** - Accept highlighted suggestion
- **Backspace** - Remove adjacent chip
- **Enter** or **Cmd+Enter** - Submit entry
- **Escape** - Clear input / exit smart mode

---

## Recurring Entries Inline

Move recurring suggestions from a separate top section into the day's entry list.

### Display

- Appear in the day's entry list, sorted with other entries
- Visually distinct: muted/faded appearance, dashed border or tinted background
- Recurring icon (⟳) visible

### Quick Actions

Visible on the row:

- **Add** - Creates the entry, row becomes normal entry
- **Skip** - Dismiss this occurrence only
- **Pause** - Pause the recurring template
- **Delete** - Remove template (with confirmation)

### Behavior

- Added entries become regular entry rows (linked to template)
- Skipped entries disappear for that day
- Unadded recurring entries reappear if you navigate away and back

---

## Implementation

### New Components

| Component | Purpose |
|-----------|---------|
| `components/entry/smart-entry-bar.tsx` | Unified input with chip handling |
| `components/entry/entry-chips-input.tsx` | Reusable chips-in-input component |
| `components/timeline/recurring-entry-row.tsx` | Pending recurring entry row |

### Modified Components

| Component | Changes |
|-----------|---------|
| `components/layout/entry-bar.tsx` | Add mode toggle, render smart or classic |
| `components/timeline/day-group.tsx` | Integrate recurring entries inline |
| `components/timeline/timeline.tsx` | Remove top-level RecurringSuggestions |

### New Modules

| Module | Purpose |
|--------|---------|
| `lib/entry-parser.ts` | Parse text into duration, dates, entity candidates |

### API

Existing `/api/v1/organizations/[orgId]/suggestions` endpoint should work. May need enhancement for scoped queries (e.g., projects for a specific client).

No schema changes required.

---

## Technical Considerations

- **Chips input**: Contenteditable div or managed segment array
- **Dropdown positioning**: Handle mobile viewport constraints
- **Keyboard state machine**: Track typing vs navigating vs editing chips
- **Parser testing**: Pure functions for easy unit testing

---

## Future Possibilities

- Persist mode preference to user settings
- Learn from user patterns to improve suggestion ranking
- Voice input integration
- Templates / quick-entry shortcuts
