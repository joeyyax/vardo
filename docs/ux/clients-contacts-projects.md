# Clients, Contacts, and Projects

This document defines how Clients, Contacts, Roles, and Projects relate to each other, and how information is gathered and refined over time.

The system is designed to support real-world ambiguity:
- Projects often start with incomplete information
- Roles change over time
- Multiple people may share responsibilities

The goal is clarity without forcing perfection up front.

---

## Core Principles

1. Clients and Projects are distinct concepts
2. Contacts belong to Clients, not Projects
3. Roles are flexible and multi-valued
4. Missing information should never block progress
5. Onboarding is the primary moment for refinement

---

## Core Objects

### Client

A Client represents the long-lived relationship.

- Typically a company, organization, or household
- Exists independently of any project
- Owns:
  - Contacts
  - Projects
  - Internal notes

A Client may exist with:
- No projects
- One project
- Many projects over time

Creating a Client does **not** imply that work has started.

---

### Project

A Project represents a specific engagement.

- Belongs to exactly one Client
- Has its own lifecycle and status
- Owns:
  - Proposals
  - Agreements
  - Onboarding
  - Tasks
  - Project-specific documents

Projects move through defined phases:
- Getting Started
- Proposal
- Agreement
- Onboarding
- Active
- Ongoing (optional)
- Offboarding (optional)

Each project progresses independently, even for repeat clients.

---

### Contact

A Contact represents a person or inbox associated with a Client.

- Belongs to exactly one Client
- May participate in multiple Projects
- May have one or more Roles
- May change roles over time

Contacts are **not** global across clients.
If the same person appears at multiple organizations, they are treated as separate Contacts.

---

## Roles

Roles describe *why* a Contact is involved, not their identity.

### Supported Roles (Initial Set)

- **Primary** – main point of contact
- **Decision Maker** – approves proposals and scope
- **Billing** – receives invoices and payment-related communication
- **Technical** – handles technical access or implementation details
- **Marketing** – involved in content or brand decisions

Roles are intentionally minimal and extensible.

---

### Role Characteristics

- A Contact may have multiple roles
- A Role may have multiple Contacts
- Roles are not mutually exclusive
- Roles may be unset

Examples:
- Jane: Primary + Marketing
- Bob: Technical
- finance@company.com: Billing

---

## Creating a Client (Imperfect Information Allowed)

### Minimum Required

- Client name

### Optional at Creation

- One Contact (often the person who initiated the conversation)

If a Contact is added:
- They default to the **Primary** role
- No other roles are required

The system does not require:
- Billing contacts
- Decision makers
- Technical contacts

This allows progress without artificial friction.

---

## Client Overview (No Project Yet)

A Client with no Projects is a valid state.

The Client overview should clearly communicate:
- The Client exists
- No work is currently active

Primary action:
- **Start a new project**

Secondary actions:
- Add or edit Contacts
- Add internal notes

No lifecycle or status is shown until a Project exists.

---

## Starting a Project

Creating a Project is the true kickoff.

### Required

- Project name
- Primary Contact (pre-filled from Client if available)

### Optional

- Internal notes

Once created:
- The Project enters the **Getting Started** phase
- The lifecycle becomes visible
- Orientation content appears

---

## Onboarding as the Refinement Phase

Onboarding is the primary moment to refine contact information.

Instead of demanding full accuracy up front, the system defers precision until context exists.

---

### Contact Confirmation During Onboarding

During onboarding, clients are asked to review and confirm contacts and roles.

Example checklist item:
> ☐ Confirm project contacts

This step explains *why* the information matters.

---

### Contact Confirmation UX

For each role, the client may:

- Confirm existing contacts
- Add one or more contacts
- Explicitly indicate that a role is not yet defined

Example:

**Billing Contacts**
- Jane Doe  
- finance@company.com  
➕ Add another  
☐ We don’t have a billing contact yet

Missing roles are acceptable and do not block progress.

---

## Multiple Contacts per Role

Roles are modeled as arrays, not single fields.

Implications:
- Billing emails go to all Billing contacts
- Notifications may target multiple roles
- Responsibility is shared, not assumed

This matches how real organizations operate.

---

## Guardrails and Constraints

1. Projects should never be blocked due to missing roles  
   (Exception: Billing may be required before invoicing)

2. Roles may change at any time  
   People leave, responsibilities shift

3. Historical accuracy matters  
   The system should retain who held a role at the time of an action (e.g. who approved a proposal)

---

## Roles vs Permissions

Roles describe *context*.  
Permissions describe *capabilities*.

The system does not require full role-based access control initially.

However:
- Roles may inform permissions later
- Not all roles imply the same access
- Permission rules should be additive, not destructive

---

## Why This Model Exists

This structure:
- Reflects real-world ambiguity
- Avoids early friction
- Allows projects to start quickly
- Supports repeat clients cleanly
- Makes dashboards clear at a glance

Clients understand:
- What exists (Client)
- What is active (Projects)
- Who is involved (Contacts)
- Why someone is looped in (Roles)

---

## Summary

- Clients are containers for relationships
- Projects are journeys with lifecycles
- Contacts live at the Client level
- Roles are flexible and multi-valued
- Onboarding refines reality instead of demanding it upfront

This model prioritizes clarity, momentum, and trust over forced structure.