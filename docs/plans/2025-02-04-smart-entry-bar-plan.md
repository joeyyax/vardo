# Smart Entry Bar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified natural language entry bar where users type freely and the system recognizes clients, projects, tasks, durations, and dates without special syntax.

**Architecture:** A chips-in-input component parses text in real-time, showing always-visible suggestions. Users Tab/click to lock in selections as chips. Parser uses position bias, confidence thresholds, and phrase detection to avoid overeager matching. Mode toggle allows switching between smart and classic entry bars.

**Tech Stack:** React, TypeScript, Tailwind CSS, existing shadcn/ui components

---

## Task 1: Entry Parser Module

**Files:**
- Create: `lib/entry-parser.ts`

**Step 1: Create parser with duration detection**

Create `lib/entry-parser.ts` with:
- `ParsedDuration` type: `{ type, value (minutes), raw, start, end }`
- `ParsedDate` type: `{ type, value (Date), raw, start, end }`
- `EntityCandidate` type: `{ type, text, start, end, isDescriptionContext }`
- `ParseResult` type: `{ duration, date, candidates, descriptionText }`
- Duration patterns: `1:30`, `1h30m`, `1.5h`, `90m`
- Description context phrases: "meeting with", "call about", "working on", etc.
- Relative date keywords: today, yesterday, monday-sunday
- `parseDuration(input)` - returns minutes and match
- `parseRelativeDate(input)` - returns Date or null
- `parseEntryText(input)` - returns full ParseResult

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

Message: "feat: add entry parser module for smart entry bar"

---

## Task 2: Entry Chips Input Component

**Files:**
- Create: `components/entry/entry-chips-input.tsx`

**Step 1: Create the chips input component**

Create `components/entry/entry-chips-input.tsx` with:
- `Chip` type: `{ id, type (client|project|task|duration|date), label, value, color? }`
- Props: chips, onChipsChange, inputValue, onInputChange, onInputKeyDown, placeholder, disabled, onFocus, onBlur
- Container div that focuses input on click
- Chips rendered inline with colored backgrounds and X remove buttons
- Client chips use client color, duration/date chips neutral
- Backspace on empty input removes last chip
- Flexible input that grows with content

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

Message: "feat: add EntryChipsInput component"

---

## Task 3: Smart Entry Bar Component

**Files:**
- Create: `components/entry/smart-entry-bar.tsx`

**Step 1: Create the smart entry bar**

Create `components/entry/smart-entry-bar.tsx` with:
- Props: orgId, roundingIncrement, onEntryCreated
- State: chips[], inputValue, suggestions[], highlightedIndex, isFocused, isSubmitting, error
- Fetch suggestions on input change (debounced 150ms)
- Extract query words from parser candidates (exclude description context)
- Arrow up/down to navigate suggestions
- Tab or Enter to select highlighted suggestion
- Convert selection to chips (client, project?, task?)
- Auto-detect duration patterns and convert to chip
- Auto-detect date keywords and convert to chip
- Submit when client + duration chips present
- Always-visible dropdown when focused with suggestions
- Add button disabled until ready, enabled when canSubmit

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

Message: "feat: add SmartEntryBar component"

---

## Task 4: Mode Toggle in Entry Bar

**Files:**
- Modify: `components/layout/entry-bar.tsx`

**Step 1: Add mode toggle and conditional rendering**

- Add imports: `Sparkles`, `List` from lucide-react, `SmartEntryBar`
- Add state: `isSmartMode` (default false)
- Wrap return in conditional:
  - If smart mode: render toggle button (List icon) + SmartEntryBar
  - If classic mode: render toggle button (Sparkles icon) + existing form
- Toggle button switches modes
- Both wrapped in consistent flex container

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Test in browser**

- Click sparkles icon → smart mode appears
- Type and verify suggestions work
- Add entry and verify it creates
- Click list icon → classic mode returns

**Step 4: Commit**

Message: "feat: add mode toggle between smart and classic entry bars"

---

## Task 5: Recurring Entry Row Component

**Files:**
- Create: `components/timeline/recurring-entry-row.tsx`

**Step 1: Create RecurringEntryRow component**

Create `components/timeline/recurring-entry-row.tsx` with:
- Props: template, date, orgId, onAdd, onSkip, onPause, onDelete
- Visual style: dashed border, primary/5 bg, slightly muted text
- Recurring icon (Repeat) at start
- Client color dot
- Project/task/description display
- Duration
- Action buttons: Add (check), Skip (skip-forward), Pause, Delete (X)
- Loading state per action

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

Message: "feat: add RecurringEntryRow component"

---

## Task 6: Inline Recurring in Day Groups

**Files:**
- Modify: `components/timeline/day-group.tsx`
- Modify: `components/timeline/timeline.tsx`

**Step 1: Update DayGroup props**

Add to DayGroup:
- `recurringTemplates?: RecurringTemplate[]`
- `onRecurringAdd?: (template) => void`
- `onRecurringSkip?: (template) => void`
- `onRecurringPause?: (template) => void`
- `onRecurringDelete?: (template) => void`

Render RecurringEntryRow for each template before regular entries.

**Step 2: Update Timeline to fetch and distribute recurring**

- Fetch recurring suggestions for the week (or per-day)
- Group templates by applicable date
- Pass to each DayGroup
- Handle add/skip/pause/delete actions
- Remove top-level RecurringSuggestions component

**Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Test in browser**

- Create recurring entry for today
- Verify it appears inline in today's group
- Add → becomes regular entry
- Skip → disappears
- Pause/Delete → template updated

**Step 5: Commit**

Message: "feat: show recurring entries inline in day groups"

---

## Task 7: Polish and Edge Cases

**Files:**
- Various components

**Step 1: Handle edge cases**

- Empty suggestions: show helpful message
- Long names: truncate with ellipsis
- Mobile dropdown positioning
- Keyboard accessibility
- Error states and recovery

**Step 2: Visual polish**

- Smooth chip transitions
- Focus ring styling
- Consistent spacing
- Loading indicators

**Step 3: Test scenarios**

- Type description first, then select client
- Type duration before client
- Rapid typing and selection
- Backspace through all chips
- Mobile viewport

**Step 4: Final commit**

Message: "feat: polish smart entry bar UX"

---

## Summary

| Task | Component | Purpose |
|------|-----------|---------|
| 1 | `lib/entry-parser.ts` | Parse duration, dates, entity candidates |
| 2 | `EntryChipsInput` | Reusable chips-in-input primitive |
| 3 | `SmartEntryBar` | Unified natural language entry |
| 4 | Entry bar toggle | Switch between modes |
| 5 | `RecurringEntryRow` | Inline recurring entry display |
| 6 | Day group integration | Show recurring inline |
| 7 | Polish | Edge cases and UX |
