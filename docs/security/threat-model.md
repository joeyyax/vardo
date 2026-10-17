# Threat model

Static pass for #788, first against `main` at `1bec44ab`, rechecked against `main` at `953402a7`. Target: a public VPS hosting client sites and the operator's own apps.

The console holds the Docker socket, so any code execution in it is root on the host. An instance admin who deploys `privileged: true` owns the host by design. The boundaries below are the ones that matter.

Status: **fixed** (on `main`), **open**, or **not a boundary**. Claims the recheck couldn't confirm are listed under [Open questions](#open-questions).

## 1. Unauthenticated to anything

| Claim | Status | Evidence |
| --- | --- | --- |
| Setup reopens once a user exists | fixed | `lib/setup.ts` latches on the first account and never reopens |
| Setup POSTs are unauthenticated while no user exists | fixed | #888: while no user exists, every `app/api/setup/**` handler and first signup refuse without the setup token (`lib/setup-token.ts`, `lib/auth/registration.ts`); the setup UI carries it as the `vardo_setup_token` cookie. After setup the config routes need an instance admin. Covered by `tests/unit/app/api/setup/setup-routes-token.test.ts`. |
| First signup becomes instance admin | open, by design | `lib/organizations/create-default-org.ts`. Concurrent signups give at most one admin. Whoever reaches the box first wins. |
| Open registration | fixed | defaults to `closed`, `lib/system-settings.ts`; `lib/auth/registration.ts` |
| GitHub webhook signature | fixed | mandatory secret, HMAC with `timingSafeEqual`, `app/api/v1/github/webhook/route.ts` |
| Auth rate limit bypass by rotating cookies | fixed | `extractIdentifier` keys the auth tier by client IP only, `lib/api/request-identity.ts` |
| Auth rate limit keyed on first `X-Forwarded-For` | fixed | #889: `scripts/peer-address.mjs` records each request's TCP peer; `proxy.ts` trusts `X-Forwarded-For` only from Traefik's container address (`lib/security/client-ip.ts`) and rewrites it for everything downstream. |
| `CF-Connecting-IP` spoofed by a client skipping Cloudflare | fixed | #902: `lib/security/client-ip.ts` reads it only when Traefik's peer, the last `X-Forwarded-For` hop, is in Cloudflare's ranges, a cloudflared container on Traefik's networks or `VARDO_TRUSTED_PROXIES`. Traefik trusts the same ranges (`lib/docker/trusted-proxies.ts`). |
| Host header poisoning of auth links | not a boundary in prod | Better Auth reads `NEXT_PUBLIC_BETTER_AUTH_URL`, set from `VARDO_DOMAIN` in `docker-compose.yml`. Dev infers from the request. |
| Postgres and Redis published on every interface, Redis has no password | fixed | both publish on `127.0.0.1` only (`docker-compose.yml`, `postgres` and `redis` `ports`). Docker's publishing skips ufw. Redis passwords: see section 8. |
| Console reachable from anywhere | optional lock | `VARDO_CONSOLE_MIDDLEWARES` locks the console's domain and IP routers; `/api/health` and the GitHub webhook stay open (`docs/console-lock.md`). Off by default. |
| Traefik API | fixed | #889: no `--api.insecure`; the API answers only a basic-auth router on the internal entrypoint, keyed from the master key (`lib/docker/traefik-api-access.ts`). Untrusted labels can't route to `@internal` services or the `traefik` entrypoint (`lib/docker/compose-policy.ts`). |

## 2. Tenant A to tenant B

| Claim | Status | Evidence |
| --- | --- | --- |
| Org routes check membership and capability | fixed | `verifyOrgAccess`/`verifyAppAccess` with `can()`, `lib/auth/permissions.ts`; nested IDs scoped through the app or org lookup, `lib/api/verify-access.ts` |
| Route walker | fixed | `tests/unit/api/route-authorization.test.ts` checks every exported handler under `app/api` reaches an auth or verify helper, or sits on a reasoned allowlist. It checks a guard runs, not which capability it checks. |
| Any signed-in user links every GitHub App installation | fixed | `app/api/v1/github/installations/sync/route.ts` (`requireAppAdmin`) and `callback/route.ts` (`isAppAdmin`) require an instance admin. Rows linked before this aren't removed. |
| Clone uses any installation of any org member | fixed | #788: only installations linked to the app's org, `github_installation_org`, `lib/git-integration/org-installations.ts`, `orgInstallations` in `prepare-repo.ts`. Org admins link their own installations, `organizations/[orgId]/github-installations/route.ts`. Migration 0086 linked existing rows to every org the linking user owns or administers. |
| Domain string injected into a Traefik rule | fixed | PATCH accepted any string. Domain writes now match `HOSTNAME_RE` (`lib/domains/manage.ts`, both environment routes); `lib/docker/compose-inject.ts` and `lib/ssl/generate-config.ts` refuse non-hostnames. |
| Compose `traefik.*` labels claim another tenant's host or the console | fixed | #887: `lib/docker/label-hosts.ts` refuses `Host()` rules for hosts the org doesn't own, checked from `resolve-compose.ts` |
| Path routes on another tenant's host | fixed | A host's domain rows may differ by path, so uniqueness is host plus path. The domain API refuses a host another org routes unless every holder is unverified and the caller proves it, which evicts them (#897), `hostHoldByOtherOrg` in `lib/domains/claim.ts`, called from `lib/domains/manage.ts`. Checked in the API only; the unique index covers host plus path, so two orgs racing for a new host on different paths can both land. |
| Domain middlewares reference another tenant's or Traefik's | fixed | untrusted orgs may name only middlewares Vardo defines (`cloudflare-only@file`); checked on write and again at deploy, `lib/domains/middlewares.ts` |
| Compose joins `vardo_internal` (Postgres, Redis) or any network | fixed | #886: untrusted orgs may join only `vardo-network` on a routed service, their own project's `vardo-p-<project>-<env>` network without aliases, and networks named for the app, `lib/docker/compose-policy.ts` |
| Every routed app shares `vardo-network` with the console | fixed | #1136: the console isn't on `vardo-network`; Traefik reaches it on `vardo_console`, which only the two join (`docker-compose.yml`, `lib/docker/console-network.ts`, `docs/console-lock.md`) |
| Top-level `volumes:` with `external`/`name` reaches another tenant's or the console's volume | fixed | #886: untrusted external volumes must carry the app's `<app>-<env>_` prefix; other volumes keep Compose's project name, `lib/docker/compose-policy.ts` |
| Invitation revoke | fixed | both accept paths ignored `revoked`; `lib/invitations/accept.ts` now claims a pending, unexpired row atomically |
| Mesh peers read any org's manifest | not a boundary | peers are trusted, `app/api/v1/mesh/sync/route.ts` |
| A linked instance runs MCP tools here as a user | not a boundary once accepted | off per peer until a signed-in admin turns on **Accept MCP calls**; then the peer can act as any verified-email user up to their role here. Calls are bearer-authenticated, HMAC-signed with a 60-second window and single-use nonce, and never forwarded again, `app/api/v1/mesh/mcp-call/route.ts`, `lib/mcp/remote.ts`, `docs/linked-instances.md` |
| A compromised linked instance starts deploys here through the webhook relay | not a boundary once accepted | off per peer until a signed-in admin turns on **Accept relayed webhooks**. Then the peer can deploy apps that already have auto deploy on, at the branch each already tracks, and create or tear down PR previews, in the org it's bound to or every org when unbound. Relays are bearer-authenticated, HMAC-signed with a 60-second window and single-use nonce, and rate-limited, `app/api/v1/mesh/webhook-relay/route.ts`, `lib/mesh/webhook-relay-receive.ts` |
| A relay chooses the code, branch or commands a deploy runs | not possible | the relay carries identifiers only; a strict schema refuses anything else, clone URLs that don't match the repo and branches that read as options. The receiver matches its own apps by repo and their configured branch, then fetches from the git host with its own credentials, `lib/git-integration/webhook-event.ts`. When the relay carries GitHub's body and the receiver holds the same webhook secret, a body that disagrees with the summary is refused. A relayed event is never relayed again. |
| The poller leaks git credentials through the process list | fixed | `git ls-remote` gets the GitHub App token, stored credentials or deploy key through env (`GIT_CONFIG_*`, `GIT_SSH_COMMAND`), never argv, `lib/git-integration/remote-head.ts` |

## 3. Member to admin

| Claim | Status | Evidence |
| --- | --- | --- |
| Role changes and invites | fixed | admin-only capabilities, `lib/auth/permissions.ts`; owner can't be changed |
| `trusted`, `allowBindMounts`, `allowDockerSocket` | fixed | instance admin only, `organizations/[orgId]/route.ts`, `projects/[projectId]/route.ts` |
| Container terminal | fixed | `app.terminal` is admin-only on the stream and input handlers, `apps/[appId]/terminal/route.ts`; logged (#813). Role table in `docs/roles.md` |
| Cron command jobs | fixed | `app.cron.command` is admin-only for creating or changing a command job, `apps/[appId]/cron/route.ts`; members keep URL crons, pause and delete. `host.toml` cron entries still create command jobs on deploy, accepted: a member can already deploy code that runs in the same container, `lib/docker/deploy-steps/post-deploy.ts` |
| API tokens | fixed | #788: a token holds its scope (full, deploy, read-only or custom capabilities) intersected with the user's live role, `tokenScopeCapabilities` in `lib/auth/permissions.ts`; applied where sessions resolve to capabilities, `lib/auth/session.ts`, `lib/api/verify-access.ts`, and in MCP, `lib/mcp/scope.ts`; scoped tokens can't use user-level write routes (`isScopedToken`); pinned to one org unless `crossOrg`; existing tokens stay full, `drizzle/0087_api_token_scopes.sql` |
| API token with instance-admin power | fixed | only with the opt-in admin scope, and only while its user is still an instance admin, `credentialMayAdmin` in `lib/auth/admin.ts`. Only a signed-in instance admin can grant it, never from a token and never on a read-only token, `organizations/[orgId]/tokens/route.ts`, `lib/auth/api-token.ts`. `drizzle/0102_api_token_admin_scope.sql` cleared the flag 0069 had set on every admin's token. |
| Any user can create an org and become its owner | open, product | `app/api/v1/organizations/route.ts`. The section 5 compose gaps that made owner mean host are fixed (#886). |

## 4. Untrusted input to execution

| Claim | Status | Evidence |
| --- | --- | --- |
| Fork PRs reach a build | fixed | `previewRefusalReason` in `lib/git-integration/pull-request.ts` refuses forks and head/base mismatch; `handlePullRequestEvent` in `lib/git-integration/webhook-handler.ts` checks it before any build, for webhooks and relays alike |
| Self-preview gets secrets | not a boundary | only same-repo PRs reach it after the fork check |
| PR previews get production secret values | fixed | #815: a preview's env snapshot regenerates every secret-named value whatever the app's clone strategy, `lib/docker/clone.ts`; a preview with no env of its own refuses to deploy rather than fall back to production's, `lib/docker/deploy.ts`. Previews stay off until #885. |
| GitHub token in `.git/config` inside the build context | fixed | was written into the origin URL; now an origin-scoped `extraheader` via `GIT_CONFIG_*` env, `lib/git-integration/clone-auth.ts`, used from `prepare-repo.ts` |
| App env vars become the Nixpacks and Railpack process env | fixed | a member's `PATH` or `LD_PRELOAD` pointed the spawn at a binary in their cloned repo, running it in the console. App vars now reach builders only as `--env`, `lib/docker/deploy-steps/prepare-repo.ts` |
| App env values stored in the build plan | fixed | `nixpacks plan` copies `--env` values into its JSON. `maskPlanEnv` masks them before `deployment.build_plan` is written, `lib/docker/build-plan.ts` |
| Git URL transports | fixed | HTTPS only, `lib/docker/validate.ts` |
| Git clone to internal HTTPS hosts | fixed | `assertGitHostAllowed` runs the SSRF guard on the host before clone, and clone and fetch pass `-c http.followRedirects=false`, `lib/docker/git-host.ts`, `prepare-repo.ts`. LAN git hosts need `VARDO_OUTBOUND_ALLOWLIST`. Resolution isn't pinned to git's own connect. |
| Push webhook deploys every app with that git URL in any org | fixed | #788: push and pull request events reach only apps in orgs linked to the payload's `installation.id` (`orgsForInstallation`), `app/api/v1/github/webhook/route.ts`. Vardo's own self-preview is the exception: it resolves before the org lookup and only for the system-managed repo. |
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
| `rootDirectory` traversal | fixed | `appRootDir`, `lib/docker/compose-root.ts`, in `prepare-repo.ts` and `build.ts`, for every org. The schema still accepts `..`, `lib/api/create-app-schema.ts`. |
| Repo symlinks copied into the slot as content | fixed | untrusted slots get a link, so the check resolves it, `lib/docker/deploy-steps/build.ts` |
| Deny list misses `/`, `/var/lib/docker`, `/run/containerd`, `/opt/vardo` when bind mounts are on | fixed for compose | the policy also refuses any ancestor of a denied path; `DENIED_MOUNT_PATHS` itself is unchanged |
| Top-level `name:` steers the shared volume and network names Vardo creates | fixed for untrusted | `crossBoundaryVolumeName` and `sharedNetworkName` use `compose.name`; the prefix check refuses the result |
| `privileged`, `cap_add`, `devices`, `security_opt`, host `network_mode`, `pid` and `ipc` | fixed | #815: refused for untrusted orgs by `hostAccessErrors` on input and by the policy on the resolved model; `pid`, `ipc` and the rest of `DROPPED_SERVICE_KEYS` never reach the container, and the drop is logged. Trusted orgs keep them, logged on every deploy, `prepare-repo.ts` |
| Slots deployed before #886 | fixed | #895: `assertSlotWithinApp` runs the check over the slot's files before `start`, `restart`, `recreate` and both rollbacks, `lib/docker/slot-guard.ts`, called from `start-app.ts` and the rollback paths in `deploy.ts` |

## 6. Secret exposure

| Claim | Status | Evidence |
| --- | --- | --- |
| Env vars in API responses | fixed | masked for members; `?reveal=true` and MCP `vardo_get_env_vars` need `env.reveal` (admins) and are logged, `apps/[appId]/env-vars/route.ts`, `organizations/[orgId]/env-vars/route.ts`, `lib/mcp/tools/get-env-vars.ts` (#813) |
| Backup target credentials | fixed | `lib/backups/target-config.ts` |
| Notification webhook `url` returned in plaintext | fixed | webhook `url` (Discord and generic) and Slack `webhookUrl` return as `****`; a masked value on PATCH keeps the stored one, `lib/notifications/mask-config.ts`, `notifications/[channelId]/route.ts` |
| Deploy log masking | fixed | one sanitized sink, `lib/docker/deploy-logger.ts`; the app's env values, org env values and resolved values are redacted by exact match on top of the patterns. Values under 6 characters and common ones (`true`, `production`) are skipped. |
| Console env reaches compose interpolation | fixed | every docker and compose process inherited `process.env`, and Compose prefers shell vars over the project `.env`, so `${ENCRYPTION_MASTER_KEY}`, `${BETTER_AUTH_SECRET}` or `${DATABASE_URL}` in a tenant compose resolved to the console's values. Now `dockerEnv()`, `lib/docker/docker-env.ts`; `tests/unit/lib/docker/docker-env-guard.test.ts` fails on a call without `env`. |
| Org invite tokens | fixed | 256-bit, hashed, 7-day expiry, `lib/invitations/token.ts` |
| Mesh invite codes | fixed, low entropy | 32-bit, 15-minute TTL, single use, `lib/mesh/invite.ts` |

## 7. SSRF

Guard: `lib/security/ssrf.ts` blocks loopback, RFC 1918, CGNAT, link-local and metadata, multicast, reserved, ULA, IPv4-mapped and NAT64 forms after DNS resolution. `lib/security/safe-fetch.ts` re-checks every redirect hop. Escape hatch: `VARDO_OUTBOUND_ALLOWLIST` or the `outbound_allowlist` setting, by hostname only (`lib/security/outbound-policy.ts`).

| Caller | Status | Evidence |
| --- | --- | --- |
| DNS rebinding between check and connect | fixed | `guardedLookup` in `lib/security/pinned-fetch.ts` vets addresses inside the socket's `lookup` |
| Notification webhooks and Slack | fixed | `lib/notifications/webhook-channel.ts` |
| URL cron jobs, app and org-level (4 KB of body, redacted) | fixed | `lib/cron/http.ts`; a trusted org may reach the job's own host on a private address, never a redirect target, `lib/cron/http.ts` |
| Domain monitor, post-deploy health check | fixed | followed redirects with plain fetch; now `safeFetch` with the allowlist plus `.<baseDomain>`, `lib/uptime/outbound.ts`, the post-deploy check in `lib/docker/deploy.ts` |
| Security scanner (headers, file exposure, TLS) | fixed | weaker regex list replaced by `ssrf.ts`; requests through `safeFetch` and the guarded lookup, `lib/security/headers.ts`, `file-exposure.ts`, `tls.ts` |
| `/api/v1/dns-check` `.localhost` branch | fixed | any signed-in user could fetch `http://169.254.169.254/x?.localhost`; hostnames only now (`isHostname`), `app/api/v1/dns-check/route.ts` |
| Registry token realm from `WWW-Authenticate` | fixed | https only, address check and allowlist, fetched through `safeFetch`, `lib/docker/image-updates/registry.ts` |
| Backup S3 `endpoint` | fixed | checked on save by `assertTargetAllowed` (S3, R2, B2 endpoints and SSH hosts through the SSRF policy; local paths under `VARDO_LOCAL_BACKUP_ROOTS`, trusted orgs or instance admins only) and on connect by `backupEndpointLookup`, `lib/backups/target-guard.ts`, `lib/backups/storage-s3.ts`. Trusted orgs and allowlisted hosts may reach private addresses; link-local stays refused. |
| Git clone host | fixed | see section 4 |
| Mesh hub URL from an invite | not a boundary | instance admin only, `app/api/v1/admin/mesh/join/route.ts` |

## 8. A compromised app container

Same starting point as Dokploy: an app's own image CVE runs code inside that app's container. Vardo neither adds nor removes much by default.

Narrows:
- No socket mount in generated compose; host-access keys refused for untrusted orgs.
- Only Traefik-routed services join `vardo-network`; others stay on the app's own network and its project's `vardo-p-*` network, which only that project's apps join.
- Default memory, CPU and process caps per QoS tier; the compose's own values win (`defaultCpuLimit`, `defaultPidsLimit` in `lib/docker/compose-inject.ts`, #889).
- Postgres and Redis no longer published beyond loopback.
- Builds and deploys refuse when Docker's disk is 95% used or has under 2 GB free, so a tenant filling it can't take the next deploy down mid-build (#815, `lib/docker/disk-guard.ts`; `VARDO_DISK_GUARD_PERCENT`, `VARDO_DISK_GUARD_MIN_FREE_GB`).

Widens or leaves open:
- `vardo-network` holds Traefik, WireGuard and the worker beside every routed app. The console isn't on it (#1136); Traefik's `:8080` answers apps only `/ping` (#889) and the worker's `/healthz` listens on loopback.
- Apps keep Docker's default `NET_RAW`, so one on `vardo-network` can ARP-spoof another app's or Traefik's address there and read the plaintext hop behind Traefik. Dropping `NET_RAW` for untrusted orgs closes it.
- `no-new-privileges` only for untrusted orgs (#889). No `cap_drop`, `read_only` or non-root `user`. A cryptominer gets every core but one on the standard tier.
- Redis has a password on installs from #889 on. Older legacy installs get one from `vardo update` once the active slot's install.sh hands updates off to the new version (#925).

## Open questions

The `953402a7` recheck confirmed every row that said "branch", the API token, PR preview and S3 rows, and that each cited file exists. These were not re-read against the code and still stand on the first pass:

- Concurrent first signups give at most one instance admin (section 1).
- The compose policy rows in section 5 and the deploy log masking thresholds in section 6.
- Whether installation rows linked before the admin check, and the rows migration 0086 linked, are still in use on existing instances.
