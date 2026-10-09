# Load harness

Measures a running Vardo before and after a tuning change. Read-only by default.

```bash
export VARDO_URL=http://localhost:3000
export VARDO_TOKEN=...            # API token (Bearer); or VARDO_TOKENS=a,b,c
export VARDO_LOAD_ORG=<orgId>     # org-scoped scenarios; required with --write

pnpm test:load                                  # read scenarios
pnpm test:load --write --apps 4                 # also deploy and delete scratch apps
pnpm test:load --ssh deploy@host --out before.json
pnpm test:load --compare before.json after.json
```

Run `pnpm test:load --help` for every option. Never point `--write` at production.

## Scenarios

| Scenario | Endpoint | Notes |
|---|---|---|
| health | `/api/health` | Unauthenticated |
| apps list, projects list, app detail, metrics history | `/api/v1/organizations/{org}/...` | App defaults to the first in the org; set `VARDO_LOAD_APP` to pick one |
| admin overview | `/api/v1/admin/overview` | Needs `VARDO_SESSION_COOKIE` (admin session). API tokens can't reach admin routes, so it's skipped without one |
| SSE | `apps/{id}/stats/stream`, `apps/{id}/logs/stream` | `--streams` held for `--stream-seconds`. Reports connect time, first event, inter-event gap and (metrics) lag |
| deploy (`--write`) | create, deploy, read `stage_timings`, delete | `traefik/whoami` by default. Reports queue wait, total, execution and per-stage time |

Each endpoint runs at every `--concurrency` level for `--duration` seconds. Token-authenticated routes are paced to 108 requests a minute per token (90% of the 120 read limit); `--rate <n>` sets another per-token rate, `--no-pace` removes the cap. Unauthenticated and cookie routes pace only with `--rate`.

## Pacing and 429s

- Workers share one slot schedule per route, so concurrency adds in-flight requests but not rate. Total rate is `rate x tokens`.
- A 429 pauses the whole route for the server's `Retry-After` (seconds or date), falling back to `RateLimit-Reset` or `X-RateLimit-Reset`, then 5s. The server sends only `Retry-After`.
- The report adds `sent/min` (requests sent per minute, 429s included). A scenario with more than 5% 429s is marked `*` and noted as "rate-limited, latencies not meaningful".
- To measure real concurrency above one token's budget, set `VARDO_TOKENS=tokA,tokB,tokC`. Tokens rotate per request and each gets its own budget, so three tokens allow 324 requests a minute per route. Create the tokens in the same org.

## Reading results

- Latency percentiles are nearest-rank over successful (2xx) requests.
- Rate-limited responses (429) are counted in their own column, not as errors. The read tier allows 120 requests a minute per token per route, so a run that draws 429s measures the limiter, not the server.
- SSE lag is client receive time minus the server's `timestamp` on each metrics point. It includes clock skew on a remote target.
- A token is capped at 60 open streams; `--streams` above that shows up as 429s.
- Queue wait is `finishedAt - startedAt - durationMs` from the deployment row.

## Server sampling

`--ssh user@host` runs one ssh round trip per tick (BatchMode, key auth) for the run's duration. It reads `docker stats` for containers with `vardo` in the name, Redis `INFO memory` and the Postgres connection count, and reports peaks.

## Cleanup

Scratch apps are named `vardo-load-<id>-<n>` in a project `vardo-load-<id>`. They're deleted on success, failure and Ctrl-C. If deletion fails the report prints a `CLEANUP FAILED` note and the exit code is 2.

## Compare

`--compare old.json new.json` pairs rows by scenario and concurrency and prints before, after, delta and percent change. Latency down and throughput up read as better; moves under 5% are treated as noise.

## Tests

`tests/unit/scripts/load-stats.test.ts` covers percentile math, compare and the parsers. `pnpm test` never generates load.
