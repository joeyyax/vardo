# Non-Goals

Scope is intentionally focused.

This document lists problems Scope does **not** try to solve. These are conscious decisions, not omissions.

If a feature request conflicts with this list, the answer is usually “no”.

---

## Scope Is Not an Accounting System

Scope does not aim to replace:
- QuickBooks
- Xero
- Wave
- Full general ledgers
- Tax preparation tools

Scope tracks work and costs.  
It does not handle compliance, taxes, or formal accounting.

---

## Scope Is Not a File Hosting Platform

Scope is not:
- A media library
- A CDN
- A document management system
- A long-term archive

File storage exists to support work artifacts:
- receipts
- screenshots
- attachments
- exports

Large media hosting and archival storage are out of scope.

---

## Scope Is Not a CRM

Scope does not aim to manage:
- sales pipelines
- lead scoring
- outreach campaigns
- customer lifecycle marketing

Clients exist to contextualize work, not to drive sales.

---

## Scope Is Not a Real-Time Communication Tool

Scope does not replace:
- Slack
- Discord
- Email
- Chat systems

Comments exist for context and coordination around work, not conversation.

---

## Scope Is Not a Fully Customizable Workflow Engine

Scope does not support:
- arbitrarily configurable states
- deeply nested workflow rules
- user-defined process engines

Workflow is intentionally opinionated and minimal.

---

## Scope Is Not an Enterprise Platform

Scope is not built for:
- hundreds of users per org
- complex departmental hierarchies
- compliance-heavy environments
- custom procurement workflows
- enterprise SSO mandates

Scope is designed for individuals and small teams.

---

## Scope Is Not a Time-Tracking Maximizer

Scope does not:
- gamify productivity
- encourage time inflation
- reward logging more hours

Time tracking exists to understand work, not to optimize for volume.

---

## Scope Does Not Hide Reality

Scope will not:
- hide internal work by default
- distort reports to look better
- optimize metrics for appearances
- obscure effort to reduce discomfort

Honest visibility is more important than flattering numbers.

---

## Scope Does Not Optimize for Abuse

Scope is not designed around worst-case bad actors.

It assumes:
- most users are honest
- misuse is rare
- abuse is better handled calmly and manually

Designing primarily for abuse degrades the experience for everyone else.

---

## Behavioral Boundaries

These are behaviors the system intentionally does not support. They are not future roadmap items.

### No Skipping Lifecycle Steps

Projects cannot skip Proposal, Agreement, or Onboarding — even for repeat clients. Projects may move through these steps quickly, but never bypass them.

### No Client-Initiated Work

Clients cannot mark onboarding complete, start active work, or trigger billing. Preparation is collaborative. Starting work is provider-controlled.

### No Inline Contract Editing

Contracts are not collaboratively edited in-place. If changes are needed, a revised agreement is generated.

### No Global Contact Reuse

Contacts do not exist globally across clients. Each client maintains its own contacts and roles.

### No Email-Driven Project Management

Email is a notification layer, not a control surface. Clients cannot approve proposals, change scope, or complete onboarding via email. Decisions happen in the workspace.

### No Implicit Scope Changes

Scope cannot change silently. All changes flow through new proposals, change orders, or explicit agreements. Tasks alone do not redefine scope.

### No Per-Client Workflow Customization

The system favors consistency over bespoke behavior. While projects differ, the workflow does not.

### No "Just This Once" Exceptions

One-off exceptions are avoided. If something truly needs to change, the system is updated — not worked around.

---

## Principle

> Scope solves the problems it can solve cleanly.
> Everything else is intentionally left out.
>
> Constraints are a feature.