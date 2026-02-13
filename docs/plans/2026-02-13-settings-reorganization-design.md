# Settings Reorganization Design

## Problem

The settings page is a single scrolling page with 11 sections mixing personal preferences, org configuration, and admin tools. It doesn't scale — team management, billing, and integrations are all planned additions.

## Decisions

1. **Horizontal tabs** for org settings (not sidebar nav, not accordions). 5 tabs is comfortable for horizontal layout.
2. **Move personal settings to `/profile`** — preferences and notifications are user-scoped, not org-scoped.
3. **Remove Settings from sidebar nav** — access org settings via org switcher menu, user settings via user avatar menu.

## Navigation Changes

### Remove
- Settings item from sidebar nav

### Org Switcher Dropdown
- Add "Settings" link → `/settings`

### User Avatar Dropdown
- "Profile" link (existing) → `/profile` — expanded to include preferences and notifications

## `/settings` — Org Settings

Admin/owner only. 5 horizontal tabs using shadcn `Tabs` with URL search params (`?tab=general`) for bookmarkable deep links.

### General Tab (default)
- Organization name, default rate, rounding
- Billing defaults (type, frequency, payment terms)
- Feature toggles (time tracking, invoicing, expenses, PM, proposals)
- Danger zone (owner only)

### Workflow Tab
- Task types (inline drag-reorder, color, archive)
- Task tags (inline create/edit/delete with colors)
- Document templates (card with link → `/settings/templates`)

### Billing Tab
- Payment providers (Stripe configuration)
- Future: subscription/plan management

### Team Tab
- Future: member management, roles, invitations
- Placeholder/empty state for now

### Integrations Tab
- Import wizard (Toggl)
- Expense intake email (org-level)
- Future: Slack, calendar, accounting integrations

## `/profile` — User Account

Single page, sections stacked vertically (small enough to not need tabs).

### Existing
- Profile info (name, avatar)
- Security (password, 2FA, passkeys — currently placeholders)
- Account deletion (danger zone)

### New Sections
- Personal preferences (sticky selections toggle)
- Notification preferences (in-app types + email delivery)

## Routes

| Route | Purpose | Change |
|-------|---------|--------|
| `/settings` | Org settings with tabs | Restructured |
| `/settings/templates` | Template list | Unchanged |
| `/settings/templates/[id]` | Template editor | Unchanged |
| `/profile` | User account + preferences | Expanded |

## Tab Implementation

- shadcn `Tabs` component with `value` controlled by URL search params
- Default tab: `general`
- Each tab renders its content inline (no separate routes per tab)
- Feature-gated sections still conditionally render within their tabs
- Permission checks: most tabs require admin/owner, profile is user-scoped
