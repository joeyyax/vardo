# Transactional Emails

This document defines the non-lifecycle (transactional) emails used by the system.

Transactional emails are:
- Triggered by a specific event
- Informational, not marketing
- Sent only when helpful or clarifying

If an email does not reduce confusion or replace a manual explanation, it should not exist.

---

## Guiding Principles

- Prefer in-app visibility over email
- Send email only when state changes or action is required
- One event = one email
- No nagging, no drip campaigns

---

## Core Transactional Emails (Recommended)

These cover the vast majority of real-world needs.

---

### 1. Proposal / Agreement Reminder (Gentle Nudge)

**Trigger**
- Proposal or agreement remains unaccepted for `{N}` days

**Purpose**
- Replace awkward manual follow-up
- Signal availability for questions

**Notes**
- Same template can be reused for proposal and agreement
- Should only send once unless manually re-triggered

**Optional Copy**
> “Just checking in — happy to answer questions.”

---

### 2. Onboarding Blocked (Missing Info)

**Trigger**
- Project in `onboarding`
- Required checklist items incomplete for `{N}` days

**Purpose**
- Clarify why progress has paused
- Prevent “are we waiting on you or me?” confusion

**Notes**
- Should name *what* is missing
- Should never sound accusatory

---

### 3. Hosting Enabled Confirmation

**Trigger**
- Hosting addendum accepted
- Hosting marked active

**Purpose**
- Confirm hosting is live
- Reinforce data access + ownership

(This email already exists in your lifecycle set.)

---

### 4. Hosting Ending Confirmation

**Trigger**
- Hosting toggled off
- Hosting scheduled to end

**Purpose**
- Confirm intent
- Point to data export + migration resources

(This is your offboarding email.)

---

### 5. Application Data Export Ready

**Trigger**
- Automated “Request Application Data” job completes

**Purpose**
- Confirm export availability
- Avoid clients wondering if something broke

**Notes**
- Should not include download links in email
- Email should point back to the portal

---

### 6. Migration Assistance Requested

**Trigger**
- Client requests migration assistance

**Purpose**
- Confirm request was received
- Set expectation that this is paid + scoped

**Notes**
- This is acknowledgment, not a quote

---

## Optional Transactional Emails (Add Later if Needed)

These are useful, but not required at launch.

---

### 7. Project Paused (Non-Payment or External Dependency)

**Trigger**
- Project status manually set to paused

**Purpose**
- Clarify why work is paused
- Prevent silent confusion

**Important**
- This should almost always be manually triggered
- Tone must be calm and factual

---

### 8. Retainer Period Reset (Informational)

**Trigger**
- New retainer period begins

**Purpose**
- Transparency around capacity reset
- Optional reassurance for clients tracking usage

**Notes**
- Can be replaced entirely by dashboard visibility

---

## Emails That Should NOT Be Automated

Explicitly documenting these prevents future mistakes.

---

### ❌ “You haven’t logged in”
- Adds anxiety
- No value

### ❌ “Your contract expires soon”
- Should be handled via dashboard + direct conversation

### ❌ “We noticed you haven’t completed X”
- Use onboarding blocked email instead

### ❌ Marketing or upsell emails
- Out of scope for this system

---

## Trigger Source of Truth

All transactional emails should be triggered by **state changes**, not timers alone.

Examples:
- `proposal_unaccepted_after_7_days`
- `onboarding_blocked_missing_access`
- `hosting_disabled`
- `export_completed`

Emails should never introduce new information that is not already visible in the app.

---

## Summary

This system intentionally limits transactional emails to:

- Clarify progress
- Confirm important actions
- Replace awkward manual messages

If an email does not make the client feel more oriented, it does not belong here.