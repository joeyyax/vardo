# Permissions by State

This document defines which roles can perform which actions in each project state.

Goals:
- Keep v1 simple and predictable
- Avoid blocking work due to missing roles
- Support real-world orgs (multiple contacts per role)
- Preserve audit trails

---

## Roles (Client-Side)

Client roles are assigned per contact (contacts belong to a client).

- **Primary** (default)
- **Decision Maker**
- **Billing**
- **Technical**
- **Marketing**

Roles are informational, but also influence permissions.

---

## Permission Groups (Actors)

For clarity, permissions are described by actor category.

### Provider
You (and your internal team, if any)

### Client – Full Access Contact
A client contact who has access to the project workspace

### Client – Decision Maker Contact
A client contact with role: Decision Maker

### Client – Billing Contact
A client contact with role: Billing

---

## Default Permission Rules (V1)

- Provider has full access in all states
- Any client contact with workspace access can:
  - View project status
  - View documents that are client-visible
  - Comment / ask questions
- Only Decision Maker (or Primary, if no Decision Maker exists) can accept proposals and agreements
- Billing contacts receive invoice-related notifications (billing system dependent)

This keeps v1 from being fragile.

---

## Actions

Legend:
- ✅ Allowed
- ⛔ Not allowed
- ◻️ Allowed only if feature enabled / applicable

---

## State: getting_started

| Action | Provider | Client (any) | Client (Decision Maker) |
|---|---:|---:|---:|
| View project | ✅ | ✅ | ✅ |
| View “How We’ll Work Together” | ✅ | ✅ | ✅ |
| Create proposal draft | ✅ | ⛔ | ⛔ |
| Comment / ask questions | ✅ | ✅ | ✅ |

Notes:
- Client can see the project exists but cannot initiate proposal creation.

---

## State: proposal

| Action | Provider | Client (any) | Client (Decision Maker / fallback Primary) |
|---|---:|---:|---:|
| View proposal | ✅ | ✅ | ✅ |
| Edit proposal draft | ✅ | ⛔ | ⛔ |
| Send proposal | ✅ | ⛔ | ⛔ |
| Accept proposal | ⛔ | ⛔ | ✅ |
| Comment / ask questions | ✅ | ✅ | ✅ |

Notes:
- Only the decision authority can accept.
- If no Decision Maker role is set, the Primary contact is the fallback acceptor.

---

## State: agreement

| Action | Provider | Client (any) | Client (Decision Maker / fallback Primary) |
|---|---:|---:|---:|
| View agreement + addenda | ✅ | ✅ | ✅ |
| Regenerate agreement | ✅ | ⛔ | ⛔ |
| Accept agreement | ⛔ | ⛔ | ✅ |
| Comment / ask questions | ✅ | ✅ | ✅ |

Notes:
- Clients cannot edit agreements; only accept or ask questions.

---

## State: onboarding

| Action | Provider | Client (any) | Client (Decision Maker) |
|---|---:|---:|---:|
| View onboarding checklist | ✅ | ✅ | ✅ |
| Complete onboarding items | ✅ | ✅ | ✅ |
| Manage contacts / roles | ✅ | ✅ | ✅ |
| Upload assets / links | ✅ | ✅ | ✅ |
| Mark onboarding complete | ✅ | ◻️ | ◻️ |

Recommendation (v1):
- Allow client to complete checklist items
- Only Provider can mark onboarding complete (prevents accidental start)

Optional mode:
- Allow decision maker to mark complete if you want it self-serve.

### Onboarding Completion

- Clients may complete individual onboarding checklist items
- Only the Provider may mark onboarding complete
- Only the Provider may advance a project from Onboarding to Active

---

## State: active

| Action | Provider | Client (any) | Client (Decision Maker) |
|---|---:|---:|---:|
| View tasks & docs | ✅ | ✅ | ✅ |
| Create task / request | ✅ | ✅ | ✅ |
| Comment on tasks | ✅ | ✅ | ✅ |
| Close/complete tasks | ✅ | ◻️ | ◻️ |
| Approve deliverables | ✅ | ◻️ | ✅ |

Recommendation (v1):
- Clients can create tasks and comment
- Provider controls task completion state
- Decision maker can approve deliverables (if you use approvals)

---

## State: ongoing

| Action | Provider | Client (any) | Client (Decision Maker) |
|---|---:|---:|---:|
| View usage/capacity (if applicable) | ✅ | ✅ | ✅ |
| Create task / request | ✅ | ✅ | ✅ |
| Comment on tasks | ✅ | ✅ | ✅ |
| Request end of service | ✅ | ✅ | ✅ |

Notes:
- “Request end of service” does not change state automatically; it opens a discussion/flow.

---

## State: offboarding

| Action | Provider | Client (any) | Client (Decision Maker) |
|---|---:|---:|---:|
| View offboarding resources | ✅ | ✅ | ✅ |
| Request application data export | ✅ | ✅ | ✅ |
| View export status | ✅ | ✅ | ✅ |
| Request migration assistance | ✅ | ✅ | ✅ |
| Create new tasks | ✅ | ⛔ | ⛔ |

Notes:
- Offboarding is read-only for work intake.
- Requests are limited to exports and migration.

---

## State: completed

| Action | Provider | Client (any) | Client (Decision Maker) |
|---|---:|---:|---:|
| View docs & history | ✅ | ✅ | ✅ |
| Request application data export (if retained) | ✅ | ◻️ | ◻️ |
| Create tasks | ✅ | ⛔ | ⛔ |

Notes:
- Completed is archival.
- Data export availability depends on retention policy.


---

## Summary

V1 intentionally keeps permissions simple:
- Provider controls creation/sending of proposals and agreements
- Client decision authority accepts
- Clients can participate and provide info without admin friction
- Onboarding completion is provider-controlled by default