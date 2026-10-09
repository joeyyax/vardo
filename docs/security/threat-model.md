# Threat model

Static pass for #788 against `main` at `1bec44ab`, plus the fixes on `fix/788-exposure-prep`. Target: a public VPS hosting client sites and Joey's apps.

The console holds the Docker socket, so any code execution in it is root on the host. An instance admin who deploys `privileged: true` owns the host by design. The boundaries below are the ones that matter.

Status: **fixed** (on main or in this branch), **open**, or **not a boundary**. "Branch" means fixed in this branch.

## 1. Unauthenticated to anything

| Claim | Status | Evidence |
| --- | --- | --- |
| Setup reopens once a user exists | fixed | `lib/setup.ts:26` latches on the first account and never reopens |
| Setup POSTs are unauthenticated while no user exists | fixed | #888: while no user exists, every `app/api/setup/**` handler and first signup refuse without the setup token (`lib/setup-token.ts`, `lib/auth/registration.ts`); the setup UI carries it as the `vardo_setup_token` cookie. After setup the config routes need an instance admin. Covered by `tests/unit/app/api/setup/setup-routes-token.test.ts`. |
| First signup becomes instance admin | open, by design | `lib/organizations/create-default-org.ts:17`. Concurrent signups give at most one admin. Whoever reaches the box first wins. |
| Open registration | fixed | defaults to `closed`, `lib/system-settings.ts:320`; `lib/auth/registration.ts:21` |
| GitHub webhook signature | fixed | mandatory secret, HMAC with `timingSafeEqual`, `app/api/v1/github/webhook/route.ts:35-55` |
| Auth rate limit bypass by rotating cookies | branch | `lib/api/with-rate-limit.ts:37` keys the auth tier by IP only |
| Auth rate limit keyed on first `X-Forwarded-For` | fixed | #889: `scripts/peer-address.mjs` records each request's TCP peer; `proxy.ts` trusts `X-Forwarded-For` only from Traefik's container address (`lib/security/client-ip.ts`) and rewrites it for everything downstream. |
| `CF-Connecting-IP` spoofed by a client skipping Cloudflare | fixed | #902: `lib/security/client-ip.ts` reads it only when Traefik's peer, the last `X-Forwarded-For` hop, is in Cloudflare's ranges, a cloudflared container on Traefik's networks or `VARDO_TRUSTED_PROXIES`. Traefik trusts the same ranges (`lib/docker/trusted-proxies.ts`). |
| Host header poisoning of auth links | not a boundary in prod | Better Auth reads `NEXT_PUBLIC_BETTER_AUTH_URL` (`docker-compose.yml:38`). Dev infers from the request. |
| Postgres and Redis published on every interface, Redis has no password | branch | `docker-compose.yml:155,173` now bind to `127.0.0.1`. Docker's publishing skips ufw. |
| Console reachable from anywhere | optional lock | `VARDO_CONSOLE_MIDDLEWARES` locks the console's domain and IP routers; `/api/health` and the GitHub webhook stay open (`docs/console-lock.md`). Off by default. |
| Traefik API | fixed | #889: no `--api.insecure`; the API answers only a basic-auth router on the internal entrypoint, keyed from the master key (`lib/docker/traefik-api-access.ts`). Untrusted labels can't route to `@internal` services or the `traefik` entrypoint (`lib/docker/compose-policy.ts`). |

## 2. Tenant A to tenant B

| Claim | Status | Evidence |
| --- | --- | --- |
| Org routes check membership and capability | fixed | `verifyOrgAccess`/`verifyAppAccess` with `can()`, `lib/auth/permissions.ts`; nested IDs scoped through the app or org lookup, `lib/api/verify-access.ts:21-24` |
| Route walker | fixed | `tests/unit/api/route-authorization.test.ts` checks every exported handler under `app/api` reaches an auth or verify helper, or sits on a reasoned allowlist. It checks a guard runs, not which capability it checks. |
| Any signed-in user links every GitHub App installation | branch | `app/api/v1/github/installations/sync/route.ts:16`, `callback/route.ts:51` now require an instance admin. Rows linked before this aren't removed. |
| Clone uses any installation of any org member | branch | #788: only installations linked to the app's org, `github_installation_org`, `lib/git-integration/org-installations.ts`, `prepare-repo.ts:382`. Org admins link their own installations, `organizations/[orgId]/github-installations/route.ts`. Migration 0086 linked existing rows to every org the linking user owns or administers. |
| Domain string injected into a Traefik rule | branch | PATCH accepted any string, `apps/[appId]/domains/route.ts:104`. Now validated there and in environment routes; `lib/docker/compose-inject.ts:120` and `lib/ssl/generate-config.ts:93` refuse non-hostnames. |
| Compose `traefik.*` labels claim another tenant's host or the console | fixed | #887 on `fix/887-label-hosts`: `lib/docker/label-hosts.ts` refuses `Host()` rules for hosts the org doesn't own, checked from `resolve-compose.ts` |
| Path routes on another tenant's host | fixed | A host's domain rows may differ by path, so uniqueness is host plus path. The domain API refuses a host another org routes, `lib/domains/shared-host.ts`. Checked in the API only, not by a constraint, so two orgs racing for a new host can both land. |
| Domain middlewares reference another tenant's or Traefik's | fixed | untrusted orgs may name only middlewares Vardo defines (`cloudflare-only@file`); checked on write and again at deploy, `lib/domains/middlewares.ts` |
| Compose joins `vardo_internal` (Postgres, Redis) or any network | fixed | #886: untrusted orgs may join only `vardo-network` on a routed service and networks named for the app, `lib/docker/compose-policy.ts` |
| Every routed app shares `vardo-network` with the console | open, by design | `lib/docker/deploy-steps/resolve-compose.ts:234-247`; apps reach `vardo-frontend:3000` directly |
| Top-level `volumes:` with `external`/`name` reaches another tenant's or the console's volume | fixed | #886: untrusted external volumes must carry the app's `<app>-<env>_` prefix; other volumes keep Compose's project name, `lib/docker/compose-policy.ts` |
| Invitation revoke | branch | both accept paths ignored `revoked`, `lib/invitations/accept.ts:17` now claims a pending row atomically |
| Mesh peers read any org's manifest | not a boundary | peers are trusted, `app/api/v1/mesh/sync/route.ts:10` |

## 3. Member to admin

| Claim | Status | Evidence |
| --- | --- | --- |
| Role changes and invites | fixed | admin-only capabilities, `lib/auth/permissions.ts:23-69`; owner can't be changed |
| `trusted`, `allowBindMounts`, `allowDockerSocket` | fixed | instance admin only, `organizations/[orgId]/route.ts:57`, `projects/[projectId]/route.ts:118` |
| Container terminal | fixed | `app.terminal` is admin-only on the stream and input handlers, `apps/[appId]/terminal/route.ts`; logged (#813). Role table in `docs/roles.md` |
| Cron command jobs | fixed | `app.cron.command` is admin-only for creating or changing a command job, `apps/[appId]/cron/route.ts`; members keep URL crons, pause and delete. `host.toml` cron entries still create command jobs on deploy, accepted: a member can already deploy code that runs in the same container, `lib/docker/deploy-steps/post-deploy.ts` |
| API tokens | branch | #788: a token holds its scope (full, deploy, read-only or custom capabilities) intersected with the user's live role, `lib/auth/permissions.ts:116-145`; applied where sessions resolve to capabilities, `lib/auth/session.ts:126`, `lib/api/verify-access.ts:13`, and in MCP, `lib/mcp/scope.ts:27`; scoped tokens can't use user-level write routes, `lib/auth/session.ts:161`; pinned to one org unless `crossOrg`; existing tokens stay full, `drizzle/0087_api_token_scopes.sql`; never instance admin, `lib/auth/admin.ts:8` |
| Any user can create an org and become its owner | open, product | `app/api/v1/organizations/route.ts:59-97`. The section 5 compose gaps that made owner mean host are fixed (#886). |

## 4. Untrusted input to execution

| Claim | Status | Evidence |
| --- | --- | --- |
| Fork PRs reach a build | fixed | `lib/git-integration/pull-request.ts:4` refuses forks and head/base mismatch; called before any build, `webhook/route.ts:154` |
| Self-preview gets secrets | not a boundary | only same-repo PRs reach it after the fork check |
| PR previews get production secret values | fixed | #815: a preview's env snapshot regenerates every secret-named value whatever the app's clone strategy, `lib/docker/clone.ts`; a preview with no env of its own refuses to deploy rather than fall back to production's, `lib/docker/deploy.ts`. Previews stay off until #885. |
| GitHub token in `.git/config` inside the build context | branch | was written into the origin URL; now a github.com-scoped header via env, `lib/git-integration/clone-auth.ts`, `prepare-repo.ts:391` |
| App env vars become the Nixpacks and Railpack process env | fixed | a member's `PATH` or `LD_PRELOAD` pointed the spawn at a binary in their cloned repo, running it in the console. App vars now reach builders only as `--env`, `lib/docker/deploy-steps/prepare-repo.ts:240` |
| Git URL transports | fixed | HTTPS only, `lib/docker/validate.ts:26` |
| Git clone to internal HTTPS hosts | fixed | `assertGitHostAllowed` runs the SSRF guard on the host before clone, and clone and fetch pass `-c http.followRedirects=false`, `lib/docker/git-host.ts`, `prepare-repo.ts:371`. LAN git hosts need `VARDO_OUTBOUND_ALLOWLIST`. Resolution isn't pinned to git's own connect. |
| Push webhook deploys every app with that git URL in any org | branch | #788: only apps in orgs linked to the payload's `installation.id`, `webhook/route.ts:89-107`. PR previews aren't scoped this way yet. |
| Hooks `bash -c` | not applicable | framework deleted |

## 5. Compose escape

Fixed by #886. For untrusted orgs, `assertComposeWithinApp` (`lib/docker/compose-policy.ts`, called from `lib/docker/deploy-steps/build.ts`) runs `docker compose config --no-env-resolution` over the slot's files with `dockerEnv()` and checks the interpolated, long-syntax result against an allowlist. Unknown keys are refused. Trusted orgs skip it. The input checks in `compose-validate.ts` still run first.

| Gap | Status | Evidence |
| --- | --- | --- |
| Bind sources `.`, `..`, `~/`, `${VAR}`, `$PWD` | fixed | checked after interpolation; any bind needs `allowBindMounts`, the socket needs `allowDockerSocket` |
| Top-level volume `driver_opts: {type: none, o: bind, device: /}` | fixed | treated as a bind of `device` |
| Top-level `configs`/`secrets` with `file:` | fixed | inside the app's directory, or a bind under the same rules |
| `env_file:` any path, e.g. `/opt/vardo/.env` | fixed | must be inside the app's directory, whatever the flags; Compose reads it inside the console |
| `build.context: /` or `../..`; `additional_contexts`; Dockerfile path | fixed | inside the app's directory |
| `rootDirectory` traversal | fixed | `appRootDir`, `lib/docker/compose-root.ts`, in `prepare-repo.ts` and `build.ts`, for every org. The schema still accepts `..`, `lib/api/create-app-schema.ts:27`. |
| Repo symlinks copied into the slot as content | fixed | untrusted slots get a link, so the check resolves it, `lib/docker/deploy-steps/build.ts:85` |
| Deny list misses `/`, `/var/lib/docker`, `/run/containerd`, `/opt/vardo` when bind mounts are on | fixed for compose | the policy also refuses any ancestor of a denied path; `DENIED_MOUNT_PATHS` itself is unchanged |
| Top-level `name:` steers the shared volume and network names Vardo creates | fixed for untrusted | `crossBoundaryVolumeName` and `sharedNetworkName` use `compose.name`; the prefix check refuses the result |
| `privileged`, `cap_add`, `devices`, `security_opt`, host `network_mode`, `pid` and `ipc` | fixed | #815: refused for untrusted orgs by `hostAccessErrors` on input and by the policy on the resolved model; `pid`, `ipc` and the rest of `DROPPED_SERVICE_KEYS` never reach the container, and the drop is logged. Trusted orgs keep them, logged on every deploy, `prepare-repo.ts:84` |
| Slots deployed before #886 | fixed | #895: `assertSlotWithinApp` runs the check over the slot's files before `start`, `restart`, `recreate` and both rollbacks, `lib/docker/slot-guard.ts`, `start-app.ts:75`, `deploy.ts:1049,1092` |

## 6. Secret exposure

| Claim | Status | Evidence |
| --- | --- | --- |
| Env vars in API responses | fixed | masked for members; `?reveal=true` and MCP `vardo_get_env_vars` need `env.reveal` (admins) and are logged, `apps/[appId]/env-vars/route.ts`, `organizations/[orgId]/env-vars/route.ts`, `lib/mcp/tools/get-env-vars.ts` (#813) |
| Backup target credentials | fixed | `lib/backups/target-config.ts:139` |
| Notification webhook `url` returned in plaintext | fixed | webhook `url` (Discord and generic) and Slack `webhookUrl` return as `****`; a masked value on PATCH keeps the stored one, `lib/notifications/mask-config.ts`, `notifications/[channelId]/route.ts` |
| Deploy log masking | fixed | one sanitized sink, `lib/docker/deploy-logger.ts`; the app's env values, org env values and resolved values are redacted by exact match on top of the patterns. Values under 6 characters and common ones (`true`, `production`) are skipped. |
| Console env reaches compose interpolation | fixed | every docker and compose process inherited `process.env`, and Compose prefers shell vars over the project `.env`, so `${ENCRYPTION_MASTER_KEY}`, `${BETTER_AUTH_SECRET}` or `${DATABASE_URL}` in a tenant compose resolved to the console's values. Now `dockerEnv()`, `lib/docker/docker-env.ts`; `tests/unit/lib/docker/docker-env-guard.test.ts` fails on a call without `env`. |
| Org invite tokens | fixed | 256-bit, hashed, 7-day expiry, `lib/invitations/token.ts:9` |
| Mesh invite codes | fixed, low entropy | 32-bit, 15-minute TTL, single use, `lib/mesh/invite.ts:26,78` |

## 7. SSRF

Guard: `lib/security/ssrf.ts` blocks loopback, RFC 1918, CGNAT, link-local and metadata, multicast, reserved, ULA, IPv4-mapped and NAT64 forms after DNS resolution. `lib/security/safe-fetch.ts` re-checks every redirect hop. Escape hatch: `VARDO_OUTBOUND_ALLOWLIST` or the `outbound_allowlist` setting, by hostname only (`lib/security/outbound-policy.ts`).

| Caller | Status | Evidence |
| --- | --- | --- |
| DNS rebinding between check and connect | branch | `lib/security/pinned-fetch.ts:13` vets addresses inside the socket's `lookup` |
| Notification webhooks and Slack | fixed | `lib/notifications/webhook-channel.ts:36,64` |
| URL cron jobs (returns 2000 bytes of body) | fixed | `lib/cron/engine.ts:88` |
| Domain monitor, post-deploy health check | branch | followed redirects with plain fetch; now `safeFetch` with the allowlist plus `.<baseDomain>`, `lib/domain-monitoring/monitor.ts:108`, `lib/docker/deploy.ts:719` |
| Security scanner (headers, file exposure, TLS) | branch | weaker regex list replaced by `ssrf.ts`; requests through `safeFetch` and the guarded lookup, `lib/security/headers.ts:74`, `file-exposure.ts:55`, `tls.ts:29` |
| `/api/v1/dns-check` `.localhost` branch | branch | any signed-in user could fetch `http://169.254.169.254/x?.localhost`; hostnames only now, `app/api/v1/dns-check/route.ts:26` |
| Registry token realm from `WWW-Authenticate` | fixed | https only, address check and allowlist, fetched through `safeFetch`, `lib/docker/image-updates/registry.ts:118-143` |
| Backup S3 `endpoint` | open, verify | unvalidated string, `lib/backups/target-config.ts:37` |
| Git clone host | fixed | see section 4 |
| Mesh hub URL from an invite | not a boundary | instance admin only, `app/api/v1/admin/mesh/join/route.ts:81` |

## 8. A compromised app container

Same starting point as Dokploy: an app's own image CVE runs code inside that app's container. Vardo neither adds nor removes much by default.

Narrows:
- No socket mount in generated compose; host-access keys refused for untrusted orgs.
- Only Traefik-routed services join `vardo-network`; others stay on the project network.
- Default memory, CPU and process caps per QoS tier; the compose's own values win (`defaultCpuLimit`, `defaultPidsLimit` in `lib/docker/compose-inject.ts`, #889).
- Postgres and Redis no longer published beyond loopback (this branch).
- Builds and deploys refuse when Docker's disk is 95% used or has under 2 GB free, so a tenant filling it can't take the next deploy down mid-build (#815, `lib/docker/disk-guard.ts`; `VARDO_DISK_GUARD_PERCENT`, `VARDO_DISK_GUARD_MIN_FREE_GB`).

Widens or leaves open:
- `vardo-network` includes the console, Traefik and WireGuard, so a routed app reaches `vardo-frontend:3000` directly. Traefik's `:8080` answers it only `/ping` (#889).
- `no-new-privileges` only for untrusted orgs (#889). No `cap_drop`, `read_only` or non-root `user`. A cryptominer gets every core but one on the standard tier.
- Redis has a password on installs from #889 on; older installs stay passwordless until `REDIS_PASSWORD` is added to `.env` and Redis is recreated.
