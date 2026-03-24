# Product Philosophy

This product exists to make running applications straightforward. Deploy, monitor, back up, scale — without needing to become an infrastructure specialist.

It treats deployment as a solved problem, not a specialization.

---

## Core Belief

**Simplicity builds confidence.
Good defaults prevent mistakes.
Ownership beats convenience.**

Every feature should reinforce these ideas.

---

## What This Product Is

- A complete platform for deploying Docker applications
- A single place to manage your apps, domains, backups, and monitoring
- An alternative to managing servers manually or paying for PaaS lock-in
- A system that works out of the box and gets out of the way

It is not:
- A Kubernetes abstraction
- A DevOps dashboard
- A CI/CD pipeline builder
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

Nothing skips a step — it just moves through faster.

---

### 2. Infrastructure Disappears

Infrastructure should be set up once and forgotten. You shouldn't think about your reverse proxy, your SSL certificates, or your backup schedule after the initial setup.

Applications are what you care about. Vardo handles the rest.

---

### 3. Honest Status

The system never pretends an app is healthy when it isn't.

If something hasn't deployed, it says so.
If a health check is failing, it says so.
If a backup failed, it says so.

No fake green. No hidden errors.

---

### 4. One Obvious Next Step

At every stage, there's one clear thing to do next.

If a page has multiple competing primary actions, the design has failed.

---

### 5. Backups Just Happen

Backups are a byproduct of running apps:
- Volumes get snapshotted automatically
- Retention policies prune old snapshots
- Restores are one click

You don't manage backup infrastructure. You see a list of snapshots you can restore from.

---

### 6. Start Simple, Refine Later

Apps often start with incomplete configuration. That's fine.

The system:
- Lets "good enough" get you running
- Refines details as you go
- Doesn't block a deploy over a missing optional field

---

### 7. Deploy Is Intentional, Rollback Is Instant

Deployments require explicit action. Auto-deploy is opt-in.
Rollbacks are one click and use the previous known-good state.

Nothing deploys by accident.

---

### 8. Monitoring Is Built In

You don't need Grafana, Prometheus, or Datadog to know if your apps are running.

- Metrics collected automatically
- Logs aggregated by default
- Health checks run continuously

If you want deeper observability, the data is there to export.

---

### 9. Portable by Default

Everything is exportable:
- Config files for migration
- Volume snapshots for data
- API for automation

Moving to a new server is a documented, supported workflow — not a crisis.

---

### 10. Automation Handles the Boring Parts

Automation exists to:
- Renew SSL certificates
- Run scheduled backups
- Monitor container health
- Retry failed notifications

Automation does not:
- Deploy without your say-so
- Delete data silently
- Make decisions you should make

---

## The Test

Before adding a feature, ask:

- Does this make something simpler?
- Does this reduce a decision the user has to make?
- Does this work without configuration?
- Would removing this make the product worse?

If the answer is "no," the feature doesn't belong.

---

## Summary

This product is designed to make running applications feel:
- Simple without being limited
- Structured without being rigid
- Reliable without being expensive
- Yours without being burdensome

If it ever feels like you need to be an infrastructure expert to use it, something has gone wrong.
