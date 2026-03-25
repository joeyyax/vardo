# Contributing to Vardo

## Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)
- Docker Desktop (or Docker Engine + Compose plugin on Linux)
- Git

---

## First-Time Setup

```bash
git clone https://github.com/joeyyax/host vardo
cd vardo
pnpm install
cp .env.example .env
```

Generate the encryption key:

```bash
openssl rand -hex 32
```

Paste the output as `ENCRYPTION_MASTER_KEY` in `.env`. The other values in `.env.example` work as-is for local development.

---

## Starting the Dev Stack

```bash
# Start Postgres + Redis (and cAdvisor, Loki)
docker compose up -d

# Start the Next.js dev server
pnpm dev
```

App is at `http://localhost:3000`.

`COMPOSE_PROFILES` is not set in dev — the `frontend` container is skipped. You run the app directly with `pnpm dev` for hot reload.

### Dev Service Ports

| Service | Port |
|---------|------|
| PostgreSQL | 7100 |
| Redis | 7200 |
| cAdvisor | 7300 |
| Loki | 7400 |
| Traefik dashboard | 8080 (if enabled) |
| Next.js app | 3000 |

---

## Database Workflow

```bash
# Apply schema changes immediately (dev only — no migration file)
pnpm db:push

# Browse the database with a GUI
pnpm db:studio

# Generate and run a migration (for production-bound changes)
pnpm db:migrate
```

Schema lives in `lib/db/schema/`. Queries are organized by domain in `lib/db/queries/`.

---

## Running Checks

Run these before pushing:

```bash
pnpm typecheck   # TypeScript — must pass
pnpm lint        # ESLint — must pass
pnpm test        # Playwright + unit tests
```

CI runs the same checks. PRs with failing typecheck or lint won't merge.

### CI pipeline

> **Planned** — Tracked in [#165](https://github.com/joeyyax/vardo/issues/165)

Automated CI runs on every PR are not yet configured. The intent is to run `pnpm typecheck`, `pnpm lint`, and `pnpm test` in GitHub Actions on every push to a PR branch. Until this is set up, run checks locally before pushing.

### Integration tests for critical paths

> **Planned** — Tracked in [#296](https://github.com/joeyyax/vardo/issues/296)

The current test suite covers unit-level logic. Integration tests for critical paths — deploy pipeline, backup job execution, webhook handling, auth flows — are planned but not yet written. These tests will run against a real Docker environment to catch regressions that unit tests miss.

If you are adding a new critical path (deploy trigger, backup target, auth method), consider opening a follow-up issue to track the needed integration test.

---

## Project Structure

```
app/
  (authenticated)/              # Authenticated routes
    projects/         # Project list + detail
    apps/             # App list + detail
    backups/          # Backup management
    admin/            # Admin panel
    metrics/          # Resource monitoring
    team/             # Team members
    settings/         # Org settings
    user/settings/    # User profile
  (public)/           # Unauthenticated routes
    onboarding/       # First-run setup wizard
  api/
    auth/[...all]/    # Better Auth handler
    v1/organizations/ # Versioned REST API

components/
  ui/                 # shadcn/ui components
  layout/             # Sidebar, mobile nav, org switcher
  backups/            # Backup UI components
  [feature]/          # Feature-specific components

lib/
  db/                 # Drizzle schema + queries
  auth/               # Better Auth config + session helpers
  backup/             # Backup job runner
  config/             # vardo.yml / vardo.secrets.yml resolution
  docker/             # Docker Engine API wrappers
  email/              # Email sending + templates
  github/             # GitHub App client
  mesh/               # Instance mesh (multi-node)
  organizations/      # Org-scoped helpers
  templates/          # Deploy template resolution
  types/              # Shared TypeScript types
```

---

## Architecture Overview

**Multi-tenant by design.** Every database query is scoped by `organization_id`. There are no global queries that return data across orgs.

**API-first.** The frontend calls the versioned REST API at `/api/v1/organizations/[orgId]/...`. Server Actions are used for simple form submissions; anything complex goes through the API.

**Config resolution chain.** Application config (email, GitHub App, feature flags) resolves in this order:
1. `vardo.yml` / `vardo.secrets.yml` (file-based — takes priority)
2. Database (admin UI)
3. Defaults

**Auth.** Better Auth handles all auth — passkeys, magic links, OAuth, 2FA. Session validation uses `lib/auth/session.ts`. Admin checks use `lib/auth/admin.ts`.

**Projects = Docker Compose.** Each project is a Docker Compose deployment. Vardo manages the lifecycle (up, down, pull, rebuild) via the Docker socket.

---

## Branch Conventions

| Prefix | Purpose |
|--------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `chore/` | Cleanup, refactoring, deps |
| `docs/` | Documentation |

Branch from `main`. Keep branches focused — one feature or fix per branch.

---

## PR Workflow

1. Branch from `main`
2. Work incrementally, commit logical units
3. Run `pnpm typecheck` before pushing
4. Push and create a PR with the relevant review labels
5. Gating reviews must pass before merge
6. Generative reviews create follow-up issues
7. `review:final` is the last gate — regression check, scope fit, clean commit history
8. Squash merge to main

### Commit Messages

Imperative mood, one logical change per commit:

```
Add backup target PATCH endpoint
Fix org switcher flicker on mobile
```

Squash granular commits before merge.

---

## Review Labels

### Gating (must pass before merge)

| Label | Scope |
|-------|-------|
| `review:security` | Injection, auth, rate limiting, headers |
| `review:architecture` | Patterns, duplication, ports & adapters |
| `review:frontend` | UX code quality, performance, visual |
| `review:infra` | Docker, compose, deploy, install scripts |
| `review:performance` | N+1 queries, re-renders, bundle size, hot paths |
| `review:database` | Schema design, migration safety, indexes, query patterns |
| `review:accessibility` | WCAG, keyboard nav, screen reader, contrast |
| `review:full` | All gating reviews |
| `review:final` | Last gate — regression check, scope, commit history |

### Generative (create follow-up work)

| Label | Scope |
|-------|-------|
| `review:docs` | Draft user-facing docs for new features |
| `review:api` | API surface consistency and discoverability |
| `review:testing` | Identify needed tests |
| `review:ux` | User flows, empty/error/loading states, microcopy |
| `review:devex` | Code ergonomics, types, patterns |

---

## Code Quality Guidelines

- TypeScript strict mode — `pnpm typecheck` must pass
- No `any` types unless genuinely unavoidable (add a comment explaining why)
- Prefer ports & adapters for infrastructure boundaries (e.g., `lib/email/send.ts` abstracts the provider)
- All queries must be org-scoped
- New API routes need auth checks — see existing routes for the pattern

---

## How to Add a New API Endpoint

1. Create the route file under `app/api/v1/organizations/[orgId]/your-resource/route.ts`
2. Validate the session: `await requireAuth(request)` (see existing routes)
3. Validate the org membership and extract `orgId` from params
4. Write queries in `lib/db/queries/your-resource.ts`
5. Return JSON with standard error shapes (see existing routes for the pattern)
6. Add `review:security` and `review:database` labels to the PR

---

## How to Add a New Settings Page

Settings pages live under `app/(authenticated)/settings/[tab]/` (org settings) or `app/(authenticated)/user/settings/[tab]/` (user settings). Admin settings are under `app/(authenticated)/admin/settings/[tab]/`.

1. Add the tab to the settings nav in `components/layout/settings-nav.tsx`
2. Create `app/(authenticated)/settings/[tab]/page.tsx`
3. Use Server Components to load initial data, Client Components for interactive forms
4. Mutations go through Server Actions or API routes
5. Use `toast` from `sonner` for success/error feedback

---

## How to Add a New Deploy Type

Deploy templates live in `lib/templates/`. Each template is a YAML file that defines the Compose structure, required environment variables, and metadata.

1. Create a template file in `lib/templates/`
2. Add the template metadata to the template registry
3. The template will appear in the new app wizard automatically
4. Add a seed entry if it should be available on fresh installs (update `seed_templates` in `install.sh`)
