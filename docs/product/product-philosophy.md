# Product Philosophy

This product exists to make running applications feel calm, clear, and intentional — for both the developer and their users.

It treats deployment as a solved problem, not a specialization.

---

## Core Belief

**Simplicity builds confidence.
Structure reduces mistakes.
Good defaults create better outcomes.**

Every feature should reinforce these ideas.

---

## What This Product Is

- A complete platform for deploying Docker applications
- A single source of truth for your infrastructure
- A calm alternative to managing servers manually
- A system that respects real-world constraints

It is not:
- A Kubernetes abstraction
- A noisy DevOps dashboard
- A replacement for CI/CD pipelines
- A place to hide complexity behind magic

---

## Design Principles

### 1. One App, One Path

Each application follows a clear lifecycle:
- Connect
- Configure
- Deploy
- Monitor
- Back Up

Apps never skip steps — they only move through them faster.

This protects data, expectations, and uptime.

---

### 2. Infrastructure and Applications Are Different Things

- Infrastructure is the server, the network, the storage
- Applications are the code, the data, the domains

Infrastructure should be set up once and forgotten.
Applications should be easy to deploy, update, and roll back.

This separation keeps the system honest.

---

### 3. Status Is Visible, Not Implied

The system never pretends an app is healthy when it isn't.

If something hasn't deployed, it's shown as not deployed.
If something is failing health checks, it's shown as unhealthy.
If a backup failed, it's shown as failed.

No fake green. No hidden errors.

---

### 4. One Primary Action at a Time

At every stage, there is exactly one obvious next step.

This reduces cognitive load and prevents mistakes.

If a page has multiple competing primary actions, the design has failed.

---

### 5. Backups Are Byproducts of Running Apps

Backups happen because apps are running:
- Volumes are snapshotted automatically
- Retention policies prune old snapshots
- Restores are one click

Users do not manage backup infrastructure.
They see a timeline of snapshots they can restore from.

---

### 6. Imperfect Configuration Is Normal

Projects often start with missing details.

The system:
- Allows "good enough" configuration to begin
- Refines details through the setup wizard
- Never blocks a deploy unnecessarily

Precision is earned through use, not demanded upfront.

---

### 7. Deployment Is Intentional. Rollback Is Instant.

Only the operator:
- Triggers deployments
- Promotes between environments
- Rolls back to previous versions

This prevents accidental deploys and protects production.

---

### 8. Monitoring Is Built In, Not Bolted On

The product does not require external monitoring tools.

- Metrics are collected automatically
- Logs are aggregated by default
- Health checks run continuously

External tools can supplement, but they're not required.

---

### 9. Migration Should Be Calm

Users own their configuration.
They can export it at any time.
Moving to a new server is structured, not adversarial.

A good migration is part of a good product.

---

### 10. Automation Supports Judgment, Not Replaces It

Automation exists to:
- Reduce busywork
- Prevent mistakes
- Improve consistency

Automation should never:
- Deploy without intent
- Delete data silently
- Surprise the operator

Human judgment remains central.

---

## The Test

Before adding a feature, ask:

- Does this make the current state clearer?
- Does this reduce confusion or just add motion?
- Does this respect real-world constraints?
- Does this protect future-me from mistakes?

If the answer is "no," the feature doesn't belong.

---

## Summary

This product is designed to make running applications feel:
- Professional without being complex
- Structured without being rigid
- Calm without being passive
- Flexible without being fragile

If it ever feels stressful, confusing, or noisy, something has gone wrong.
