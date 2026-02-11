# Email-Based Expense & Record Intake

## Purpose

Email-based intake exists to capture **business records**, not to automate accounting.

Many costs, subscriptions, and client-related charges arrive as emails:
- invoices
- receipts
- renewal notices
- usage summaries
- payment confirmations

Forwarding these emails into Scope creates a **reliable paper trail** and preserves context without requiring users to change how information already arrives.

This feature prioritizes **record-keeping and provenance**, not automation.

---

## Core Principle

> **Email is a document source, not a data source.**

Scope does not attempt to:
- parse totals automatically
- guess categories
- infer billability
- reconcile accounts

Human review is always required.

---

## How It Works

Each organization is assigned a unique, unguessable email address, for example: 4tbF3LsiSdxXowwvK1lxLJixfqvCzalXDHpTLW5uQWsEaAgr5ERD2TZKcDSRio8s.intake@usescope.net

When an email is sent to this address:

1. Attachments are extracted (PDFs and images only)
2. A new item is created in the **Expense Inbox**
3. The item is marked:
   - source: Email
   - status: Needs review
   - billable: false (default)
4. Original metadata is preserved:
   - sender
   - subject
   - received date

No finalized expense is created automatically.

---

## Accepted Content

Email intake accepts:
- PDF attachments
- Image attachments (JPG, PNG, HEIC)

Email body content may be preserved as a reference, but is not parsed or interpreted.

Emails with no valid attachments are ignored.

---

## Expense Inbox

The **Expense Inbox** is a holding area for unreviewed items.

Inbox items:
- are not expenses yet
- do not affect reports or invoices
- cannot be billed

From the inbox, users can:
- create a new expense
- attach files to an existing expense
- mark the item as informational only
- discard the item

This ensures that nothing enters the system without explicit confirmation.

---

## Common Use Cases

- Forwarding SaaS subscription invoices (e.g. hosting, tools)
- Capturing client-related receipts received via email
- Keeping records of renewal notices and plan changes
- Preserving proof of cost without immediate categorization

Not every record needs to become an expense.

---

## What This Feature Does Not Do

Email intake intentionally does **not**:
- auto-create expenses
- auto-assign clients or projects
- extract totals or taxes
- determine billability
- sync with banks or financial institutions

These constraints are deliberate and protect correctness and trust.

---

## Design Rationale

Automated ingestion of financial data creates liability when it is wrong.

By treating email as an **input channel**, not a source of truth, Scope:
- reduces errors
- avoids silent mistakes
- keeps users in control
- minimizes support burden

This aligns with Scope’s broader philosophy of calm, explicit software.

---

## Plan & Limits

Email intake may be subject to:
- attachment size limits
- total storage caps per plan
- rate limiting

Limits are designed to prevent abuse while keeping the feature useful for normal business use.

---

## Summary

Email-based intake is a quiet, optional power feature.

It exists to:
- preserve records
- capture context
- reduce friction
- support real-world workflows

Nothing happens automatically.  
Nothing is hidden.  
Everything is reviewable.