# Contributing

For first-time setup, prerequisites, and development workflow, see [docs/contributing.md](../docs/contributing.md).

## Branch Conventions

| Prefix | Purpose |
|--------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `chore/` | Cleanup, refactoring, deps |
| `docs/` | Documentation |

## PR Workflow

1. Branch from `main`
2. Work incrementally, commit logical units
3. Run `pnpm typecheck` before pushing
4. Push and create PR with review labels
5. Gating reviews must pass before merge
6. Generative reviews create follow-up work
7. `review:final` is the last gate -- regression, scope, clean commit history
8. Squash merge to main

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
| `review:final` | Last gate -- regression check, scope fit, big picture |

### Generative (create follow-up work)

| Label | Scope |
|-------|-------|
| `review:docs` | Draft user-facing docs for new features |
| `review:cli` | Evaluate CLI command opportunities |
| `review:api` | API surface consistency and discoverability |
| `review:testing` | Identify needed tests -- unit, integration, e2e |
| `review:ux` | User flows, empty/error/loading states, microcopy |
| `review:devex` | Code ergonomics, types, patterns |

## Code Quality

- TypeScript strict mode
- `pnpm typecheck` must pass
- `pnpm lint` must pass
- No `any` types unless unavoidable
- Prefer ports & adapters for infrastructure boundaries

## Commit Messages

- Concise, imperative mood ("Add X", "Fix Y", not "Added X")
- One logical change per commit
- Squash before merge if granular
