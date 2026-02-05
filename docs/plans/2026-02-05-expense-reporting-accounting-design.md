# Expense Reporting & Accounting Design

**Date:** 2026-02-05
**Status:** Approved

## Problem

The expenses section lacks:
- Filtering by client, project, or vendor
- Paid vs unpaid status tracking
- Export functionality
- Tax-year reporting and summaries

Additionally, the relationship between Reports and potential accounting features was unclear, risking UI confusion.

## Solution

Three-layer approach with clear separation of concerns:

1. **Contextual** – Enhanced filtering and export where data lives (Expenses page)
2. **Dashboard** – Glanceable business health (Reports → Overview)
3. **Accounting** – Tax prep and exports (Reports → Accounting tab)

---

## Layer 1: Expenses Page (Contextual Enhancements)

### New Filters

Add to existing filter bar:
- **Client** dropdown
- **Project** dropdown (filtered by selected client)
- **Vendor** dropdown (autocomplete from history)
- **Status**: All | Paid | Unpaid
- **Date range** picker

Summary stats update dynamically based on active filters.

### Export

- "Export current view" button – exports filtered results as CSV
- Cross-link: "Need full tax export? → Accounting"

### Schema Changes

Add to `projectExpenses` table:

```sql
vendor TEXT,                    -- "Adobe", "AWS", etc. (autocomplete, not FK)
status TEXT DEFAULT 'paid',     -- 'paid' | 'unpaid'
paid_at DATE                    -- Optional: when payment was made
```

### Vendor Approach

- Free-text field with autocomplete from previously used vendors
- No separate Vendors management page
- List builds organically from usage
- Optional future: "Merge vendors" utility in Settings to clean duplicates

---

## Layer 2: Reports Page (Restructured)

Convert Reports from a single dashboard to a tabbed interface:

| Tab | Purpose |
|-----|---------|
| **Overview** | Dashboard. Current period stats, glanceable health metrics. (Mostly exists today) |
| **Accounting** | Tax prep. Year selector, stat cards with export, year in review. |
| **Client Reports** | Outward-facing shared reports. (Promote existing collapsible to tab) |

### Why Tabs?

- Single nav item (no confusion between "Reports" vs "Accounting")
- Clear internal separation based on intent
- Room to grow (Trends, Forecasting tabs someday)

---

## Layer 3: Accounting Tab (New)

### Period Selector

- Year tabs: 2025 | 2024 | 2023 | Custom range
- Smart defaults: Before April 15 → previous tax year, otherwise current year

### Stat Cards

```
┌─────────────────────────┐  ┌─────────────────────────┐
│  Expenses               │  │  Income                 │
│  $12,450                │  │  $87,200                │
│  142 expenses           │  │  1,847 hours billed     │
│                         │  │                         │
│  [View] [Export CSV]    │  │  [View] [Export CSV]    │
└─────────────────────────┘  └─────────────────────────┘

┌─────────────────────────┐  ┌─────────────────────────┐
│  Profit                 │  │  Outstanding            │
│  $74,750                │  │  $4,200                 │
│  85.7% margin           │  │  3 unpaid invoices      │
│                         │  │                         │
│  [View breakdown]       │  │  [View invoices]        │
└─────────────────────────┘  └─────────────────────────┘
```

Each card:
- Shows headline number + supporting detail
- **View** button → links to filtered view of that data
- **Export CSV** button → downloads data for that period

### Year in Review

Below stat cards, collapsible or always visible:

```
Year in Review: 2025

You tracked 1,847 hours across 12 clients.
Top client: Acme Corp (340 hrs, $28,500)
Busiest month: October
Revenue growth: +12% vs 2024
```

Simple narrative summary. Not a complex visualization.

---

## Cross-Linking Strategy

People land in the right place no matter where they start.

### From Expenses Page
- Link near export: "Need full tax export? → Reports → Accounting"
- Client name clicks → Client page

### From Reports → Overview
- Each summary card has "View all →" link to relevant section
- Expense card → Expenses page
- Invoice card → Invoices page

### From Reports → Accounting
- "View" on Expenses card → Expenses page filtered to selected year
- "View" on Income card → Time entries or Invoices filtered to selected year
- "View breakdown" on Profit → expands inline or links to Overview

### From Client/Project Pages
- Contextual expense summary for that entity
- "See all expenses →" filtered to that client/project

---

## Design Principles Applied

1. **Time-aware defaults** – Surface what users probably need based on calendar
2. **Painfully obvious** – Users aren't accountants; guide them to the right place
3. **No dead ends** – Cross-link everywhere you'd naturally ask "can I see more?"
4. **Minimal friction** – Vendor autocomplete, not lookup tables. Export what you see.
5. **Single nav item** – Tabs inside Reports, not competing top-level items

---

## Implementation Phases

### Phase 1: Schema + Expenses Filtering
- Add `vendor`, `status`, `paid_at` to `projectExpenses`
- Add filters to Expenses page (client, project, vendor, status, date range)
- Add "Export current view" button

### Phase 2: Reports Tab Structure
- Convert Reports page to tabbed layout
- Move existing content to Overview tab
- Promote Shared Reports collapsible to Client Reports tab
- Add empty Accounting tab

### Phase 3: Accounting Tab
- Period selector with smart defaults
- Stat cards (Expenses, Income, Profit, Outstanding)
- Export functionality for each card
- Year in Review summary

### Phase 4: Cross-Linking
- Add contextual links from Expenses → Accounting
- Add "View" links from Accounting → filtered views
- Add expense summaries to Client/Project pages

---

## Open Questions

None at this time. Design approved.
