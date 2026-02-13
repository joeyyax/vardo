# Team Management Design

## Overview

Team management for medium-sized orgs (5-20 people) with role-based access and project-scoped visibility. Members join via email invitation or shareable join link. Members only see projects they're assigned to; admins and owners see everything.

## Roles & Permissions

| Capability | Owner | Admin | Member |
|---|---|---|---|
| Org settings (general, billing, workflow) | Yes | Yes | No |
| Invite/remove members | Yes | Yes | No |
| Manage roles | Yes | Yes (can't change owner) | No |
| See all time entries & reports | Yes | Yes | No |
| See all clients/projects | Yes | Yes | Only assigned projects + their clients |
| Create clients/projects | Yes | Yes | No |
| Track time (own entries) | Yes | Yes | Yes (assigned projects only) |
| Submit expenses | Yes | Yes | Yes (assigned projects only) |
| Approve expenses | Yes | Yes | No |
| Invoicing | Yes | Yes | No |

## Joining an Org

### Email Invitation

Owner/admin enters an email address and picks a role. An invite email is sent with a token link. The recipient signs up or logs in, then is added to the org with the specified role.

### Join Link

A shareable URL that anyone can use to join as `member` (default role). Owner/admin can:

- Toggle the link on/off
- Copy the link
- Regenerate the token (invalidates the old link)

## Data Model

### New table: `team_invitations`

| Column | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| organizationId | UUID | FK → organizations |
| email | text | Invitee email |
| role | text | Role to assign (admin, member) |
| invitedBy | text | FK → users |
| token | text | Unique invite token |
| status | text | pending, accepted, expired |
| createdAt | timestamp | |
| expiresAt | timestamp | |

### New table: `project_members`

| Column | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| projectId | UUID | FK → projects |
| userId | text | FK → users |
| createdAt | timestamp | |

Controls which projects a member can see and interact with. Admins and owners bypass this check — they have implicit access to all projects.

### Org table additions

- `joinToken` (text, nullable) — token for the shareable join link
- `joinEnabled` (boolean, default false) — whether the join link is active

## UI

### `/team` page

Full page accessed from the org switcher dropdown (next to Settings).

- **Member list**: name, email, role, joined date
- **Role management**: dropdown to change roles (owner/admin only, can't change owner role)
- **Remove member**: button with confirmation (owner/admin only)
- **Pending invitations**: list with resend and revoke actions
- **Invite form**: email input + role selector
- **Join link section**: toggle on/off, copy link, regenerate button

### Project dashboard

New "Team" section on the project dashboard:

- Shows assigned members for that project
- Add/remove member selector (owner/admin only)
- Note that admins/owners have implicit access (not listed as explicit members)

### Org switcher dropdown

Add "Team" item below Settings with a Users icon:

```
[Org list]
---
Settings
Team
---
Create organization
```

## API Filtering

All existing API routes that return org-scoped data need a visibility check based on the user's role:

- **Owner/Admin**: no filtering, see everything
- **Member**: filter by `project_members` join — only returns data for projects the member is assigned to

Affected areas:

- Time entries (own entries only, assigned projects only)
- Expenses (own submissions only, assigned projects only)
- Projects (only assigned projects)
- Tasks (only tasks in assigned projects)
- Clients (only clients that have at least one assigned project)
- Reports (own data only; admins/owners get full team reports)

## Non-goals (for now)

- Sub-teams or groups within an org
- Per-feature granular permissions (beyond role-based)
- Domain-based auto-join
- SSO / SAML
- Audit logging of permission changes
