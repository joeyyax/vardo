# Why This Exists

Deploying apps shouldn't require a specialization.

But most developers end up with some version of:
- A VPS they SSH into manually
- A reverse proxy they configured once and pray still works
- A backup strategy that's "I should really set that up"
- A deploy process that lives in their head or a bash script

The pieces don't connect. So you do the connecting — manually, every time.

---

## The Problem Isn't Skill

Most developers aren't bad at ops.

They're just working with tools that:
- Treat deployment, monitoring, and backups as completely separate problems
- Are built for scale they'll never need
- Assume a dedicated ops team exists

The result: you spend more time operating your apps than building them.

---

## A Different Approach

Vardo starts from a simple idea:

**Running apps has a lifecycle.**

Setup, deployment, monitoring, backups, scaling — these are connected steps, not separate products.

When the platform handles all of them:
- Deploys just work
- Backups happen automatically
- SSL configures itself
- Monitoring is built in
- You don't need a separate tool for each concern

---

## Opinionated, On Purpose

This isn't a tool that tries to support every infrastructure pattern.

It makes deliberate choices:
- Docker Compose, not Kubernetes
- Git push or image deploy, not pipeline builders
- One server, then mesh — not clusters from day one
- Batteries included, not assembly required

Not because flexibility is bad — but because unnecessary complexity costs time you could spend on your product.

---

## Built From Real Work

This system wasn't designed in theory.

It grew out of:
- Real apps that needed deploying
- Real backups that were forgotten
- Real SSL certificates that expired
- Real frustration with PaaS pricing and vendor lock-in

It exists because the alternatives were either too simple (no backups, no monitoring) or too complex (Kubernetes, Terraform, Helm charts).

---

## The Goal

The goal isn't to manage your infrastructure for you.

It's to give you a platform that handles the operational work, so you can focus on what you're actually building.

That's it.
