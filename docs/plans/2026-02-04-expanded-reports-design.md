# Expanded Reports Dashboard Design

## Overview

Transform the reports page from time-tracking-only analytics into a comprehensive business dashboard covering all enabled modules: time, invoicing, expenses, and project management.

## Key Decisions

- **Adaptive dashboard**: Only show sections for enabled features
- **Single page layout**: Scrollable sections, not tabs
- **Unified date range**: All sections use the same period selection
- **Revenue source priority**: Use invoiced amounts if invoicing enabled, otherwise calculated billable time

## Page Structure

```
┌─────────────────────────────────────────────────────┐
│ Reports                                             │
│ Analytics and business insights                     │
│                                                     │
│ [Period: This Month ▾] [Custom Range]               │
├─────────────────────────────────────────────────────┤
│ FINANCIAL SUMMARY (always shown)                    │
├─────────────────────────────────────────────────────┤
│ TIME BREAKDOWN (if time_tracking)                   │
├─────────────────────────────────────────────────────┤
│ INVOICE STATUS (if invoicing)                       │
├─────────────────────────────────────────────────────┤
│ EXPENSE BREAKDOWN (if expenses)                     │
├─────────────────────────────────────────────────────┤
│ PROJECT HEALTH (if pm)                              │
├─────────────────────────────────────────────────────┤
│ SHARED REPORTS (collapsible)                        │
└─────────────────────────────────────────────────────┘
```

## Section Details

### 1. Financial Summary

Always shown. Provides high-level business metrics.

| Card | Calculation | Condition |
|------|-------------|-----------|
| Revenue | Invoiced amounts OR billable time × rates | Always |
| Expenses | Sum of expenses in period | `expenses` enabled |
| Margin | Revenue - Expenses (with percentage) | `expenses` enabled |
| Outstanding | Unpaid invoice totals | `invoicing` enabled |

**Revenue logic:**
- If `invoicing` enabled: sum of paid invoices in period
- Otherwise: sum of billable time × applicable rates
- Subtitle indicates source: "From invoices" or "Billable time"

**Margin display:**
- Shows absolute amount and percentage
- Color coding: green if positive, red if negative

### 2. Time Breakdown

Shown when `time_tracking` is enabled.

**Cards:**
| Card | Value |
|------|-------|
| Total Time | Hours tracked in period |
| Billable Amount | Hours × rates (correct inheritance chain) |
| Unbillable Time | Non-billable hours + percentage of total |
| Utilization | Billable hours ÷ Total hours |

**Client breakdown chart:**
- Horizontal bars showing hours per client
- Split bars: billable (solid) vs unbillable (faded)
- Sortable by hours or revenue

**Top Projects list:**
- Top 5 projects by hours in period
- Columns: Project, Client, Hours, Amount

### 3. Invoice Status

Shown when `invoicing` is enabled.

**Cards:**
| Card | Value |
|------|-------|
| Paid | Collected in period |
| Pending | Sent, not yet due |
| Overdue | Past terms, unpaid |
| Draft | Created, not sent |

**Aging breakdown:**
Stacked bar or list showing outstanding by age:
- Current (not yet due)
- 1-30 days overdue
- 31-60 days overdue
- 60+ days overdue

**Recent activity:**
Last 5-10 invoice events: paid, sent, viewed

### 4. Expense Breakdown

Shown when `expenses` is enabled.

**Cards:**
| Card | Value |
|------|-------|
| Total Expenses | Sum in period |
| Billable | Marked billable to clients |
| Non-billable | Internal/overhead |

**By category chart:**
Horizontal bars showing distribution across categories (software, hosting, contractor, travel, supplies, etc.)

**By project list:**
Top 5 projects by expense amount

**Recovery rate:**
Small metric: percentage of expenses billed to clients

### 5. Project Health

Shown when `pm` is enabled.

**Cards:**
| Card | Value |
|------|-------|
| Active Projects | Non-archived count |
| On Budget | Under threshold |
| At Risk | 80-100% consumed |
| Over Budget | Exceeding budget |

**Budget status table:**
Active projects with budgets, sorted by risk:
- Project name, Client
- Budget type (hours or fixed)
- Usage: "32h / 40h" or "$2,400 / $3,000"
- Progress bar (green → yellow → red)

Projects without budgets shown in separate simple list.

### 6. Shared Reports

Moved from tab to collapsible section at bottom.
- Collapsed by default, shows count
- Expands to existing report configs UI

## Date Picker

**Presets dropdown:**
- This Week
- This Month
- This Quarter
- This Year

**Custom range:**
- Button opens date range picker
- Select start and end dates
- Display: "Jan 15 - Feb 4, 2026"

All sections use the same selected range.

## API Changes

### Existing endpoint updates

`GET /api/v1/organizations/[orgId]/analytics`
- Add optional `from` and `to` query params
- Keep `period` param for presets

### New endpoints needed

`GET /api/v1/organizations/[orgId]/reports/invoices`
- Returns: paid, pending, overdue, draft totals
- Aging breakdown
- Recent activity list

`GET /api/v1/organizations/[orgId]/reports/expenses`
- Returns: totals by billability
- Category breakdown
- Project breakdown

`GET /api/v1/organizations/[orgId]/reports/projects`
- Returns: budget status for all projects
- Counts by status (on budget, at risk, over)

### Response shape example

```typescript
// Invoice report
{
  paid: number;        // cents
  pending: number;
  overdue: number;
  draft: number;
  aging: {
    current: number;
    days1to30: number;
    days31to60: number;
    days60plus: number;
  };
  recentActivity: Array<{
    invoiceId: string;
    invoiceNumber: string;
    event: 'paid' | 'sent' | 'viewed';
    amount: number;
    date: string;
  }>;
}
```

## Implementation Notes

- Reuse existing card components from current analytics
- Each section is a separate component for clean feature flag handling
- Consider loading sections in parallel (multiple API calls)
- Skeleton loaders per section, not blocking full page

## Out of Scope

- Comparison periods ("vs last month")
- Export to PDF/CSV
- Scheduled email reports
- Smart time entry suggestions (separate feature)
