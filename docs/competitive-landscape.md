# Self-Hosted PaaS Competitive Landscape

*Last updated: 2026-03-25*

This document maps every meaningful player in the self-hosted PaaS space — direct competitors, adjacent managed platforms, infrastructure tools that overlap, and newer entrants gaining traction.

---

## 1. Direct Competitors — Self-Hosted PaaS

These are the platforms most directly comparable to Vardo: open-source, self-hosted, deploy Docker apps on your own server with a web UI.

### Coolify

| | |
|---|---|
| **What** | Self-hostable alternative to Vercel/Heroku/Netlify. Supports static sites, databases, full-stack apps, and 280+ one-click services. |
| **GitHub** | [coollabsio/coolify](https://github.com/coollabsio/coolify) — **52,089 stars** |
| **Stack** | PHP (Laravel), Docker |
| **License** | Apache-2.0 |
| **Differentiator** | Massive one-click app catalog, managed cloud offering (coolify.io/cloud), very active community. Arguably the market leader in this space. |
| **Activity** | Very active. Last push: 2026-03-25. |
| **Notes** | v4 is a complete rewrite. Revenue model: managed hosting + sponsorships. Founder (Andras Bacsai) is a solo developer who built significant momentum. UI is functional but not polished. PHP/Laravel stack is a love-it-or-hate-it factor. |

### Dokploy

| | |
|---|---|
| **What** | Open-source alternative to Vercel, Netlify, and Heroku with Docker Swarm support and Traefik integration. |
| **GitHub** | [Dokploy/dokploy](https://github.com/Dokploy/dokploy) — **32,012 stars** |
| **Stack** | TypeScript (Next.js + tRPC), Docker |
| **License** | Custom (not standard SPDX) |
| **Differentiator** | Modern TypeScript stack, multi-server via Docker Swarm, built-in monitoring, Traefik-native. Cleaner UI than Coolify. |
| **Activity** | Very active. Last push: 2026-03-24. |
| **Notes** | Fastest-growing competitor. Cloud offering launched. The TypeScript stack makes it the closest architectural comp to Vardo. License is technically "Dokploy Community License" (not pure OSS). |

### Dokku

| | |
|---|---|
| **What** | Docker-powered PaaS that manages the full application lifecycle via `git push` deployments, heavily inspired by Heroku. |
| **GitHub** | [dokku/dokku](https://github.com/dokku/dokku) — **31,940 stars** |
| **Stack** | Shell/Go, Docker |
| **License** | MIT |
| **Differentiator** | The OG self-hosted Heroku alternative. CLI-first (no web UI). Buildpack and Dockerfile support. Plugin ecosystem. Battle-tested over 10+ years. |
| **Activity** | Very active. Last push: 2026-03-25. |
| **Notes** | No web UI is both its strength (simplicity) and weakness (accessibility). Single-server only without plugins. Mature and stable but feels dated compared to newer tools. Ideal for developers who live in the terminal. |

### CapRover

| | |
|---|---|
| **What** | "Heroku on Steroids" — automated Docker + nginx PaaS with one-click app deployment and cluster support via Docker Swarm. |
| **GitHub** | [caprover/caprover](https://github.com/caprover/caprover) — **14,935 stars** |
| **Stack** | TypeScript/Node.js, Docker Swarm, nginx |
| **License** | Apache-2.0 |
| **Differentiator** | One of the earliest modern self-hosted PaaS tools. Built-in cluster mode, one-click apps, Let's Encrypt. Solid but aging UI. |
| **Activity** | Low activity. Last push: 2026-01-31 (infrequent commits). |
| **Notes** | Development has slowed significantly. Still widely recommended on Reddit/HN but increasingly seen as "the old guard." nginx-based (most newer tools use Traefik). |

### Kubero

| | |
|---|---|
| **What** | Self-hosted Heroku alternative that runs on Kubernetes with GitOps-based deployments. |
| **GitHub** | [kubero-dev/kubero](https://github.com/kubero-dev/kubero) — **4,210 stars** |
| **Stack** | TypeScript/Node.js, Kubernetes |
| **License** | GPL-3.0 |
| **Differentiator** | The only direct competitor that's Kubernetes-native (not Docker Compose/Swarm). GitOps workflow, buildpack support, add-on ecosystem. |
| **Activity** | Moderate. Last push: 2026-02-28. |
| **Notes** | Small but growing. The Kubernetes requirement limits adoption for the "simple self-hosting" crowd but appeals to teams already on K8s. |

### Ptah.sh

| | |
|---|---|
| **What** | Self-hosted Heroku alternative built with Laravel and Docker Swarm. |
| **GitHub** | [ptah-sh/ptah-server](https://github.com/ptah-sh/ptah-server) — **230 stars** |
| **Stack** | PHP (Laravel), Docker Swarm |
| **License** | Custom |
| **Differentiator** | Focused on simplicity. Docker Swarm for orchestration. Very early stage. |
| **Activity** | Appears stalled. Last push: 2024-12-14. |
| **Notes** | Not a serious threat. Development seems to have stopped. |

### Tsuru

| | |
|---|---|
| **What** | Open-source, extensible PaaS originally built by Globo.com (Brazilian media company). |
| **GitHub** | [tsuru/tsuru](https://github.com/tsuru/tsuru) — **5,264 stars** |
| **Stack** | Go, Kubernetes |
| **License** | BSD-3-Clause |
| **Differentiator** | Enterprise-grade, Kubernetes-native, used in production at large scale. Multi-cloud support. |
| **Activity** | Active. Last push: 2026-03-19. |
| **Notes** | More of an enterprise/platform-engineering tool than a "deploy my side project" PaaS. Not competing for the same audience as Vardo. |

### Flynn (DEAD)

| | |
|---|---|
| **What** | Was a next-generation open-source PaaS. |
| **GitHub** | [flynn/flynn](https://github.com/flynn/flynn) — **7,932 stars** (archived) |
| **License** | BSD-3-Clause |
| **Status** | **Unmaintained/Archived.** Last push: 2021. |
| **Notes** | Historical reference. Was once the most promising Heroku alternative. Failure to find a sustainable business model led to its death. A cautionary tale. |

---

## 2. Adjacent Competitors — Managed PaaS

Users choosing between self-hosted and managed are evaluating these. They're the "just pay and forget" alternative to tools like Vardo.

| Platform | Model | Pricing Starts | Key Differentiator |
|---|---|---|---|
| **Railway** | Managed PaaS | Usage-based (~$5/mo) | Best DX in the space. `railway up` deploys anything. GitHub integration, instant previews. |
| **Fly.io** | Managed PaaS | Usage-based (~$5/mo) | Edge computing, global distribution, Firecracker VMs. Great for latency-sensitive apps. |
| **Render** | Managed PaaS | Free tier, $7/mo+ | Closest to "new Heroku." Auto-deploy from Git, managed Postgres, cron jobs. |
| **Heroku** | Managed PaaS | $5/mo+ (no free tier) | The original. Still widely used but lost mindshare after removing free tier (2022). Salesforce-owned. |
| **Vercel** | Managed PaaS | Free tier, $20/mo+ | Frontend/Next.js focused. Not a general PaaS but dominates the Jamstack deploy space. |
| **Netlify** | Managed PaaS | Free tier, $19/mo+ | Static sites + serverless functions. Similar positioning to Vercel but less framework-opinionated. |
| **DigitalOcean App Platform** | Managed PaaS | $5/mo+ | Simple PaaS built on DO infrastructure. Less flexibility than Railway/Render. |
| **Northflank** | Managed PaaS | Free tier, usage-based | Full-featured PaaS with microservice support. Can also run on your own cloud (BYOC). |
| **Coherence** | Managed PaaS | Free tier | Full-stack cloud automation on your own AWS/GCP. Infrastructure-as-code generated for you. |

**Why this matters for Vardo:** The managed PaaS market is commoditizing. Price sensitivity and data sovereignty are the primary drivers pushing users toward self-hosted. Vardo's pitch should emphasize cost savings at scale and full ownership, not try to match DX of Railway/Vercel.

---

## 3. Infrastructure / Container Management Tools

Not full PaaS, but tools that overlap with parts of what Vardo does.

### Portainer

| | |
|---|---|
| **What** | Docker and Kubernetes management UI — the most popular container management tool. |
| **GitHub** | [portainer/portainer](https://github.com/portainer/portainer) — **36,950 stars** |
| **Stack** | TypeScript (Go backend), Docker/K8s |
| **License** | Zlib |
| **Differentiator** | Universal container management. Supports Docker standalone, Swarm, K8s, Nomad. Enterprise features (RBAC, registries, edge computing). |
| **Activity** | Very active. Commercial company with paid tiers. |
| **Notes** | Not a PaaS (no git-push deploys, no buildpacks, no automatic SSL). But it's what many people use when they just need "a UI for Docker." The most common tool Vardo users might already have installed. |

### Dockge

| | |
|---|---|
| **What** | Fancy, reactive Docker Compose stack manager. From the creator of Uptime Kuma. |
| **GitHub** | [louislam/dockge](https://github.com/louislam/dockge) — **22,605 stars** |
| **Stack** | TypeScript, Node.js |
| **License** | MIT |
| **Differentiator** | Docker Compose-native. Edit compose files directly in a beautiful UI. Real-time terminal output. Multi-host agent support. |
| **Activity** | Moderate. Last push: 2026-01-21. |
| **Notes** | This is the closest "infrastructure tool" competitor to Vardo's Docker Compose management approach. Very popular on r/selfhosted. However, it's purely a compose file editor/runner — no domains, no SSL, no git integration, no CI/CD. Vardo should be "Dockge but with PaaS features." |

### Yacht

| | |
|---|---|
| **What** | Docker container management UI with emphasis on templated one-click deployments. |
| **GitHub** | [Yacht-sh/Yacht](https://github.com/Yacht-sh/Yacht) — **3,845 stars** |
| **Stack** | Vue.js, Python |
| **License** | CC-BY-4.0 |
| **Differentiator** | Template-based app store concept. Community-maintained templates. |
| **Activity** | Moderate. Last push: 2026-03-19. |
| **Notes** | Niche. The "decentralized app store" angle is interesting but hasn't gained critical mass. |

### Swarmpit

| | |
|---|---|
| **What** | Lightweight Docker Swarm management UI. |
| **GitHub** | [swarmpit/swarmpit](https://github.com/swarmpit/swarmpit) — **3,418 stars** |
| **Stack** | Clojure |
| **License** | EPL-1.0 |
| **Differentiator** | Purpose-built for Docker Swarm. Mobile-friendly. |
| **Activity** | Low. |
| **Notes** | Niche tool for Swarm users. Not a PaaS. |

### Rancher

| | |
|---|---|
| **What** | Complete container management platform for Kubernetes. |
| **GitHub** | [rancher/rancher](https://github.com/rancher/rancher) — **25,441 stars** |
| **Stack** | Go |
| **License** | Apache-2.0 |
| **Differentiator** | Enterprise Kubernetes management. Multi-cluster, multi-cloud. SUSE-backed. |
| **Activity** | Very active (enterprise). |
| **Notes** | Different market segment entirely. Enterprise K8s management, not indie/small-team PaaS. |

---

## 4. Deployment Tools (Not PaaS, But Related)

These aren't platforms with a UI, but they solve the "deploy my app to a server" problem.

### Kamal (Basecamp)

| | |
|---|---|
| **What** | Deploy web apps anywhere using Docker, from Basecamp. Zero-downtime deploys over SSH. |
| **GitHub** | [basecamp/kamal](https://github.com/basecamp/kamal) — **13,955 stars** |
| **Stack** | Ruby |
| **License** | MIT |
| **Differentiator** | CLI tool (no UI). SSH-based deploys. Zero-downtime with Kamal Proxy. Built by DHH/Basecamp, bundled with Rails 8. |
| **Activity** | Very active. |
| **Notes** | Important competitor philosophically. Kamal says "you don't need a PaaS, just deploy over SSH." Rails-ecosystem focused but usable with any Docker app. No web UI, no multi-tenant, no project management. Vardo could position as "Kamal but with a UI and multi-tenant management." |

### Piku

| | |
|---|---|
| **What** | "The tiniest PaaS." Git push deployments to your own servers, inspired by Dokku. |
| **GitHub** | [piku/piku](https://github.com/piku/piku) — **6,567 stars** |
| **Stack** | Python |
| **License** | MIT |
| **Differentiator** | Extremely minimal. Runs on anything including a Raspberry Pi. No Docker required — uses system-level process management. |
| **Activity** | Low-moderate. Last push: 2026-01-31. |
| **Notes** | Appeals to minimalists who find even Dokku too heavy. No Docker, no containers, just uwsgi/nginx. Niche but beloved. |

### SST (formerly Serverless Stack)

| | |
|---|---|
| **What** | Build full-stack apps on your own infrastructure using infrastructure-as-code. |
| **GitHub** | [anomalyco/sst](https://github.com/anomalyco/sst) — **25,718 stars** |
| **Stack** | TypeScript/Go |
| **License** | MIT |
| **Differentiator** | IaC framework for AWS/Cloudflare. Not self-hosted but "own your infrastructure." Live Lambda development. |
| **Activity** | Very active. |
| **Notes** | Different approach: code-first infrastructure instead of UI-driven PaaS. Targets developers who want cloud provider control without vendor lock-in to a PaaS. Not a direct competitor but captures some of the "own your infra" mindset. |

### Nixpacks (Railway)

| | |
|---|---|
| **What** | App source + Nix packages + Docker = Container image. Built by Railway. |
| **GitHub** | [railwayapp/nixpacks](https://github.com/railwayapp/nixpacks) — **3,491 stars** |
| **Stack** | Rust |
| **License** | MIT |
| **Differentiator** | Better buildpacks. Auto-detects language and builds optimized Docker images. Used by Railway internally. |
| **Activity** | Active. |
| **Notes** | Not a PaaS but a build tool. Could be adopted by Vardo as a build backend (like how Railway, Coolify, and others use it). Worth watching as a potential integration. |

---

## 5. Home Server / Personal Cloud Platforms

These overlap with the "self-hosted app deployment" use case but target home users rather than developers.

### CasaOS

| | |
|---|---|
| **What** | Simple, elegant personal cloud OS with a Docker app store. |
| **GitHub** | [IceWhaleTech/CasaOS](https://github.com/IceWhaleTech/CasaOS) — **33,478 stars** |
| **Stack** | Go |
| **License** | Apache-2.0 |
| **Differentiator** | Beautiful UI, beginner-friendly, designed for home hardware (ZimaBoard, RPi, NUC). One-click app installs. |
| **Activity** | Slowed. Last push: 2025-08. Company may be pivoting to hardware (ZimaOS). |
| **Notes** | Not developer-focused. No git deploys, no custom app building. But captures the "app store for your server" concept that many PaaS tools also try to provide. |

### Runtipi

| | |
|---|---|
| **What** | Personal homeserver with one-click app installs. |
| **GitHub** | [runtipi/runtipi](https://github.com/runtipi/runtipi) — **9,321 stars** |
| **Stack** | TypeScript |
| **License** | GPL-3.0 |
| **Differentiator** | "App store" model for self-hosted software. Very simple setup. Community-maintained app catalog. |
| **Activity** | Active. Last push: 2026-03-21. |
| **Notes** | Similar to CasaOS in positioning. Targets non-technical users who want to run Nextcloud, Jellyfin, etc. Not a PaaS for deploying custom code. |

### Sandstorm

| | |
|---|---|
| **What** | Self-hostable web app package manager with security sandboxing. |
| **GitHub** | [sandstorm-io/sandstorm](https://github.com/sandstorm-io/sandstorm) — **7,016 stars** |
| **Stack** | JavaScript |
| **License** | Custom |
| **Differentiator** | Security-first approach. Each app runs in its own sandbox. Unique grain-based permission model. |
| **Activity** | Low (community-maintained). |
| **Notes** | Pioneering project but never achieved mainstream adoption. Interesting security model worth studying. |

---

## 6. Serverless / FaaS (Tangential)

### OpenFaaS

| | |
|---|---|
| **What** | Serverless functions on Docker and Kubernetes. |
| **GitHub** | [openfaas/faas](https://github.com/openfaas/faas) — **26,120 stars** |
| **Stack** | Go |
| **License** | MIT (CE), Commercial (Pro) |
| **Differentiator** | Functions-first. Scale to zero. Kubernetes-native. |
| **Notes** | Different paradigm (functions not apps) but overlaps in the "deploy code to your server" space. |

---

## 7. Market Summary

### Star Count Leaderboard (Self-Hosted PaaS + Infra Tools)

| Rank | Project | Stars | Category |
|------|---------|-------|----------|
| 1 | Coolify | 52,089 | Direct PaaS |
| 2 | Portainer | 36,950 | Container Mgmt |
| 3 | CasaOS | 33,478 | Home Server |
| 4 | Dokploy | 32,012 | Direct PaaS |
| 5 | Dokku | 31,940 | Direct PaaS (CLI) |
| 6 | OpenFaaS | 26,120 | FaaS |
| 7 | SST | 25,718 | IaC Framework |
| 8 | Rancher | 25,441 | K8s Management |
| 9 | Dockge | 22,605 | Compose Manager |
| 10 | CapRover | 14,935 | Direct PaaS |
| 11 | DevPod | 14,812 | Dev Environments |
| 12 | Kamal | 13,955 | Deploy Tool |
| 13 | Runtipi | 9,321 | Home Server |
| 14 | Flynn | 7,932 | Dead PaaS |
| 15 | Sandstorm | 7,016 | App Sandbox |
| 16 | Piku | 6,567 | Tiny PaaS |
| 17 | Tsuru | 5,264 | Enterprise PaaS |
| 18 | Kubero | 4,210 | K8s PaaS |
| 19 | Yacht | 3,845 | Container Mgmt |
| 20 | Swarmpit | 3,418 | Swarm Mgmt |
| 21 | Ptah.sh | 230 | Dead PaaS |

### Competitive Positioning Map

```
                        Full PaaS Features
                              ↑
                              |
              Coolify ●       |       ● Dokploy
                              |
           CapRover ●         |         ● Kubero
                              |
              Dokku ●         |
                              |
         ← CLI/Terminal ——————+—————— Web UI →
                              |
              Kamal ●         |         ● Portainer
                              |
               Piku ●         |         ● Dockge
                              |
                              |       ● CasaOS
              SST ●           |       ● Runtipi
                              |
                        Infra Tool Only
```

### Where Vardo Fits

Vardo's opportunity is the **Docker Compose-focused PaaS** niche:

1. **Not CLI-only** like Dokku/Kamal/Piku — has a web UI
2. **Not kitchen-sink** like Coolify — focused on Docker Compose deployments
3. **Compose-native** like Dockge — but with PaaS features (domains, SSL, git, CI/CD)
4. **Modern stack** like Dokploy — Next.js, TypeScript, Drizzle
5. **Multi-tenant** — organizations, RBAC, team management (most competitors are single-user)

### Key Gaps in the Market

1. **Compose-first with PaaS UX** — Dockge proves demand for compose management; nobody has married it with proper PaaS features (domains, SSL, deploys, monitoring).
2. **Multi-tenant / team-ready** — Most self-hosted PaaS tools are single-user or bolt on teams as an afterthought. First-class multi-org support is rare.
3. **API-first architecture** — Coolify and Dokploy are UI-first. An API-first platform enables CLI tools, CI/CD integrations, and ecosystem building.
4. **Modern auth** — Passkeys, OAuth, magic links. Most competitors still use email/password only.
5. **Clean license** — Coolify (Apache-2.0) and Dokku (MIT) have clean licenses. Dokploy's custom license and Portainer's Zlib-with-enterprise-restrictions create friction. A clean MIT/Apache license is a differentiator.

### Threats to Watch

- **Coolify v4** continues to dominate mindshare and recently crossed 50k stars
- **Dokploy** is the fastest-growing competitor with the closest technical overlap (TypeScript, Next.js)
- **Kamal** is redefining expectations — DHH's influence means Rails developers increasingly think "I don't need a PaaS"
- **Dockge** could add PaaS features and become a direct threat given its 22k+ star base
- **Nixpacks** as a build standard could become table stakes — Vardo may need to support it

---

## 8. Easypanel (Closed-Source Notable)

**Easypanel** (easypanel.io) is worth mentioning as a closed-source competitor:
- Modern UI, Docker-based, self-hosted
- Free tier for up to 3 projects, paid plans for more
- Not open-source (no GitHub repo to analyze)
- Growing in the self-hosted community
- Differentiator: templates and a managed service option
- Threat level: moderate — closed source limits adoption in the OSS crowd but the UX is polished

---

*This landscape is current as of March 2026. The self-hosted PaaS space is rapidly evolving — recommend revisiting quarterly.*
