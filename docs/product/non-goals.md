# Non-Goals

Vardo is intentionally focused.

This document lists problems Vardo does **not** try to solve. These are conscious decisions, not omissions.

If a feature request conflicts with this list, the answer is usually "no".

---

## Vardo Is Not Kubernetes

Vardo does not aim to replace:
- Kubernetes
- Docker Swarm
- Nomad
- AWS ECS

Vardo runs Docker Compose on a single server (or a small mesh of servers). It does not orchestrate clusters, manage pod scheduling, or implement service mesh networking.

If you need horizontal auto-scaling across dozens of nodes, Vardo is not the right tool.

---

## Vardo Is Not a Cloud Provider

Vardo does not:
- Provision VPS instances
- Manage cloud resources (EC2, GCE, DigitalOcean droplets)
- Abstract across multiple cloud providers
- Handle DNS registration

You bring the server. Vardo runs on it.

---

## Vardo Is Not a CI/CD Pipeline

Vardo does not:
- Run test suites
- Build container images in a pipeline
- Manage build caching or artifacts
- Support multi-stage deployment workflows

Vardo deploys from Git or pre-built images. Testing happens before deployment — in GitHub Actions, GitLab CI, or wherever your team already works.

---

## Vardo Is Not a Serverless Platform

Vardo does not:
- Run edge functions
- Manage Lambda-style invocations
- Support event-driven architectures
- Auto-scale to zero

Vardo runs containers. They stay running.

---

## Vardo Is Not a Multi-Tenant Hosting Platform

Vardo does not:
- Isolate untrusted tenants
- Support billing per customer
- Provide per-tenant resource quotas
- Handle tenant onboarding

Vardo is for your apps, your team. Not for hosting other people's apps as a service.

---

## Vardo Does Not Replace Monitoring Tools

Vardo includes basic monitoring:
- Container metrics
- Log aggregation
- Health checks

But it does not replace:
- Datadog
- Grafana + Prometheus
- PagerDuty

If you need advanced alerting, APM, or distributed tracing — Vardo's metrics are a starting point, not the destination.

---

## Vardo Does Not Manage Databases

Vardo runs databases as containers (PostgreSQL, MySQL, Redis) with persistent volumes and automated backups.

It does not:
- Provide managed database services
- Handle replication or failover
- Optimize query performance
- Manage connection pooling

Database containers are apps like any other. Vardo protects their data through backups.

---

## Vardo Does Not Optimize for Distrust

Vardo is not designed around worst-case bad actors.

It assumes:
- most users are trusted team members
- the server is in your control
- misuse is rare

Designing primarily for hostile environments degrades the experience for everyone else.

---

## Behavioral Boundaries

These are behaviors the system intentionally does not support. They are not future roadmap items.

### No Automatic Scaling

Containers do not auto-scale based on load. If you need more capacity, you add an instance to the mesh and promote projects to it.

### No Build-Time Secrets Injection

Secrets are available at runtime via environment variables, not during Docker builds. Build-time secrets leak into image layers.

### No Implicit Deployments

Code pushes only trigger automatic deployment if auto-deploy is explicitly enabled. Nothing deploys without intent.

### No Cross-Org Data Access

Organizations are fully isolated. No admin backdoor, no shared data, no cross-org queries.

### No Undo on Destructive Actions

Deleting an app, org, or project is permanent. Confirmation dialogs exist for a reason.

---

## Principle

> Vardo solves the problems it can solve cleanly.
> Everything else is intentionally left out.
>
> Constraints are a feature.
