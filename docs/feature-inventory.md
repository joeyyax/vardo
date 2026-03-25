# Vardo Feature Inventory

Source of truth for all docs, marketing, and comparisons. Derived from walking the actual codebase — not guessed.

Last updated: 2026-03-25

---

## Deployment & Apps

6 deploy types: `compose`, `dockerfile`, `image`, `static`, `nixpacks`, `railpack`

- **Blue-green deploys** — zero-downtime by default. New containers come up, health check, traffic swaps, old slot torn down.
- **Auto-rollback** — grace period monitoring detects crashes and swaps back automatically
- **Git source** — clone any git URL, GitHub App auth or SSH deploy key
- **Docker image source** — pull pre-built images directly
- **Inline compose** — paste compose YAML in the UI
- **Compose decomposition** — multi-service compose files broken into managed child apps
- **Preview environments** — PR-triggered ephemeral deployments, auto-create on open, auto-destroy on close, PR comment with preview URLs
- **Dependency graph** — `dependsOn` between apps for ordered deploys
- **Clone strategies** — clone, clone_data, empty, skip (for environment cloning)
- **App transfers** — move apps between organizations

## Infrastructure

- **Mesh networking** — WireGuard-based peer-to-peer tunnels between Vardo instances
- **Multi-node sync** — project manifests replicate across nodes
- **Peer types** — persistent and dev, with online/offline/unreachable status
- **Mesh operations** — clone, promote, pull apps between instances
- **Traefik routing** — auto-generated labels, managed reverse proxy
- **DNS checks** — verify domain resolution before routing
- **Wildcard domains** — base domain + per-app subdomains
- **Docker resource limits** — CPU cores, memory MB per app
- **Container health checks** — configurable health endpoints

## SSL/TLS

- **Multiple ACME issuers** — Let's Encrypt (default), Google Trust Services, ZeroSSL
- **Per-domain resolver selection** — override the default issuer per domain
- **ZeroSSL EAB support** — External Account Binding credentials
- **Automatic certificate management** — via Traefik cert resolvers

## Backup & Recovery

- **Storage adapters** — S3, Cloudflare R2, Backblaze B2, SSH/SFTP, local filesystem
- **Per-volume backup strategies** — `tar` for file volumes, `pg_dump` for Postgres
- **Scheduled jobs** — cron expressions, configurable retention policies
- **Backup restore** — restore from any backup point
- **Backup download** — download backup archives directly
- **Auto-backup engine** — system-level automated backups
- **Feature flag gating** — `ALLOW_LOCAL_BACKUPS` restricts local targets

## Monitoring & Observability

- **Container metrics** — CPU, memory, network, disk via cAdvisor
- **Real-time streaming** — Server-Sent Events for live metrics and logs
- **Historical stats** — time-series data for trend analysis
- **Loki log aggregation** — centralized logging with Docker fallback
- **Disk write alerts** — configurable thresholds for volume monitoring
- **System alerts** — health monitoring at 60-second intervals
- **Activity log** — audit trail for all operations
- **Digest system** — aggregated notification summaries

## Authentication & Access Control

- **Auth methods** — passkey (WebAuthn), GitHub OAuth, magic link, password + TOTP
- **Registration modes** — closed, open, approval-required
- **Multi-tenant organizations** — full org isolation
- **RBAC** — owner, admin, member roles
- **API tokens** — SHA-256 hashed, org-scoped, `vardo_` prefixed
- **Session management** — configurable duration (default 7 days), auto-refresh
- **Provider restrictions** — `ALLOW_PASSWORD_AUTH`, `ALLOW_SMTP` env var gates

## GitHub Integration

- **GitHub App** — installations with per-repo access
- **Auto-deploy** — push webhook triggers deploy for matching branch
- **Preview environments** — PR webhook creates/destroys ephemeral environments
- **Repo browser** — list installations, repos, branches from the UI
- **Environment variable scanning** — detect env var usage in repos
- **Webhook signature verification** — HMAC-SHA256

## Notifications

- **Email channels** — SMTP, Mailpace, Resend, Postmark
- **Webhook channels** — HTTP POST to any URL
- **Slack channels** — via webhook URL
- **Event-driven dispatch** — deploy success/failure, backup complete, system alerts
- **Retry logic** — failed notifications retry with backoff
- **Scheduled delivery** — notification batching

## Configuration

- **vardo.yml** — config-as-code for system settings
- **vardo.secrets.yml** — encrypted secrets file (0600 permissions)
- **Config resolution** — file > database > hardcoded defaults
- **Feature flags** — database-stored, admin-toggleable
- **AES-256-GCM encryption** — at-rest encryption for sensitive settings
- **Config export/import** — admin API endpoints

## AI & Automation

- **MCP server** — Model Context Protocol at `/api/mcp` with Bearer token auth
- **Read-only tools** — list apps, get status, get logs, list projects
- **Stateless per-request** — no session persistence, fresh server each call

## Additional Features

- **Cron jobs** — scheduled task execution per app
- **Environment variables** — per-app and org-level shared vars
- **Domain management** — add, verify, set primary, health checks
- **Terminal access** — WebSocket terminal into running containers
- **Volume management** — list, size limits
- **Template system** — pre-configured app templates
- **Tags** — organize apps with labels
- **Search** — cross-entity search (apps, projects)
- **Docker Compose validation** — syntax checking and compatibility fixes
- **Git SSH key management** — deploy keys for private repos

## API Surface

106 endpoints across:
- Organizations, members, invitations
- Projects, apps, deployments
- Domains, environments, env vars
- Backups (targets, jobs, history, restore, download)
- Monitoring (stats, logs, containers, events, volumes)
- Notifications, digest, activity log
- GitHub (installations, repos, branches, webhooks, env scan)
- Mesh (peers, join, invite, clone, promote, pull, sync, heartbeat)
- Admin (health, stats, overview, users, organizations, docker prune, config export/import)
- Templates, search, tags, transfers, deploy keys, API tokens
- MCP server
- System alerts
