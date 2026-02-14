# Budget Visibility Design

## Problem

Budget tracking infrastructure is fully built (schema, API calculations, status classification) but visibility is siloed in the Reports tab. When doing day-to-day work — viewing projects, tracking time, scanning the project list — there's zero budget context. Users have to actively navigate to Reports to see if a project is running hot.

## Design Principle

**Budget is ambient awareness, not a gate.** Informational, calm, never blocking or interruptive. The goal is to surface "are we running hot?" so the user can have a conversation with the client or adjust scope — not to stop work or create urgency.

## Existing Infrastructure

- **Schema**: `budgetType` (hours/fixed), `budgetHours`, `budgetAmountCents` on projects
- **API**: `/projects/[id]/stats` returns budget remaining, usage %; `/reports/projects` returns health classification
- **Status thresholds**: on-budget (< 80%), at-risk (80-100%), over-budget (> 100%)
- **Rate inheritance**: Task > Project > Client > Org (used for fixed-budget calculations)
- **UI**: Reports tab has full `ProjectHealth` component; project edit modal has budget CRUD

## Shared Component: `<BudgetBar />`

A single reusable component with two rendering modes:

### Bar mode (default)
- Thin progress bar, colored by status:
  - Green: < 80% used
  - Amber: 80-100% used
  - Red: > 100% used
- Text label: "32/40 hrs" or "$3,200/$4,000"

### Dot mode (compact)
- Small colored status dot (same green/amber/red)
- Tooltip on hover shows the numbers

### Responsive behavior
- Uses **container queries** so parent context determines mode
- Cards/rows auto-switch between bar and dot based on available space
- No viewport breakpoints — container-driven

### Empty state
- Projects without budgets render nothing (no placeholder, no empty bar)

## Surface 1: Project List / Cards

- `<BudgetBar />` in bar mode, inline in the project row or card
- Falls to dot mode in tight containers (mobile, compact card layouts)
- Projects without budgets show no budget indicator

## Surface 2: Project Detail View

Budget widget section (only renders if project has a budget):

- **`<BudgetBar />`** — larger treatment with more visual presence
- **Key numbers**: hours used, hours remaining, effective rate
- **Burn context**: "Avg ~5 hrs/week — ~2 weeks remaining at this pace"
  - Calculated from recent entry velocity on the project
- **Link**: "View detailed breakdown" navigates to Reports tab filtered to this project

## Surface 3: Popovers (Time Entry Hover, Project Selector Cards)

- `<BudgetBar />` in bar mode, tucked into existing popover/card content
- Same compact treatment as list view — consistent visual language
- Only renders if the referenced project has a budget set

## Data Requirements

All three surfaces need the same core data:
- `budgetType`, `budgetHours` or `budgetAmountCents`
- Total minutes logged (all-time for budget comparison)
- Effective rate (for fixed-budget conversion to hours)

The project detail view additionally needs:
- Average hours/week (recent velocity for burn context)
- Link/filter params for the Reports tab

The `/projects/[id]/stats` endpoint already returns most of this. The project list/popovers may need budget data included in the list query to avoid N+1 fetches.

## Out of Scope

- Budget alerts/notifications (separate feature)
- Task-level budget aggregation or reservation
- Budget forecasting beyond simple burn rate
- Client portal budget visibility
- Blocking or warning users from logging time over budget
