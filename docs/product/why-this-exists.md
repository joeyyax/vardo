# Why This Exists

Deploying apps shouldn't be harder than building them.

But over time, most developers end up juggling:
- A VPS with manual setup
- A CI/CD pipeline
- A reverse proxy configuration
- A backup strategy (maybe)
- A handful of undocumented steps in their head

The pieces don't connect.
So you do the connecting — manually, constantly.

That gets exhausting.

---

## The Problem Isn't Skill

Most developers and small teams aren't incompetent at ops.

They're just working inside a model that:
- Treats deployment, monitoring, and backups as separate problems
- Optimizes for scale instead of simplicity
- Assumes you have a dedicated ops person

That's where friction comes from.

---

## A Different Approach

Vardo starts from a simple idea:

**Running apps has a lifecycle.**

Setup, deployment, monitoring, backups, scaling — these are connected steps, not separate problems.

When the platform reflects that:
- Deployments just work
- Backups happen automatically
- SSL configures itself
- Monitoring is built in, not bolted on

---

## Opinionated, On Purpose

This isn't a tool that tries to support every infrastructure pattern.

It makes deliberate choices:
- Docker Compose, not Kubernetes
- Git push deploy, not pipeline builders
- One server, then mesh — not clusters
- Batteries included, not assembly required

Not because flexibility is bad — but because complexity is expensive.

---

## Built From Real Work

This system wasn't designed in theory.

It grew out of:
- Real apps that needed deploying
- Real backups that were forgotten
- Real SSL certificates that expired
- Real frustration with PaaS pricing and lock-in

It exists because the alternatives didn't fit.

---

## The Goal

The goal isn't to manage your infrastructure.

It's to give you a platform that:
- Thinks about operations
- So you can focus on your product

That's it.
