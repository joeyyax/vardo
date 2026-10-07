# Contributing

## Setup

Requires Node.js 22+, pnpm and Docker.

```bash
pnpm install
cp .env.example .env
openssl rand -hex 32    # paste into ENCRYPTION_MASTER_KEY in .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev
```

`pnpm test` runs typecheck, lint and vitest. `pnpm test:e2e` runs Playwright.

`scripts/db-snapshot.sh` saves and restores the app, project and domain tables for local dev. Run it without arguments for usage.

## Branch conventions

| Prefix | Purpose |
|--------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `chore/` | Cleanup, refactoring and deps |
| `docs/` | Documentation |

## PR workflow

1. Branch from `main`
2. Work incrementally and commit logical units
3. Run `pnpm typecheck` before pushing
4. Push and create PR with review labels
5. Gating reviews must pass before merge
6. Generative reviews create follow-up work
7. `review:final` is the last gate — regression, scope, clean commit history
8. Squash merge to main

## Review labels

### Gating (must pass before merge)

| Label | Scope |
|-------|-------|
| `review:security` | Injection, auth, rate limiting and headers |
| `review:architecture` | Patterns, duplication and ports & adapters |
| `review:frontend` | UX code quality, performance, visual |
| `review:infra` | Docker, compose, deploy and install scripts |
| `review:performance` | N+1 queries, re-renders, bundle size and hot paths |
| `review:database` | Schema design, migration safety, indexes and query patterns |
| `review:accessibility` | WCAG, keyboard nav, screen reader and contrast |
| `review:full` | All gating reviews |
| `review:final` | Last gate: regression check, scope fit, big picture |

### Generative (create follow-up work)

| Label | Scope |
|-------|-------|
| `review:docs` | Draft user-facing docs for new features |
| `review:cli` | Evaluate CLI command opportunities |
| `review:api` | API surface consistency and discoverability |
| `review:testing` | Identify needed tests -- unit, integration and e2e |
| `review:ux` | User flows, empty/error/loading states and microcopy |
| `review:devex` | Code ergonomics, types and patterns |

## Code quality

- TypeScript strict mode
- `pnpm typecheck` must pass
- `pnpm lint` must pass
- No `any` types unless unavoidable
- Prefer ports & adapters for infrastructure boundaries

## Commit messages

- Concise, imperative mood ("Add X", "Fix Y", not "Added X")
- One logical change per commit
- Squash before merge if granular
