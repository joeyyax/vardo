# Threat model

Static pass for #788 against `main` at `1bec44ab`, plus the fixes on `fix/788-exposure-prep`. Target: a public VPS hosting client sites and Joey's apps.

The console holds the Docker socket, so any code execution in it is root on the host. An instance admin who deploys `privileged: true` owns the host by design. The boundaries below are the ones that matter.

Status: **fixed** (on main or in this branch), **open**, or **not a boundary**. "Branch" means fixed in this branch.

## 1. Unauthenticated to anything

| Claim | Status | Evidence |
| --- | --- | --- |
| Setup reopens once a user exists | fixed | `lib/setup.ts:26` latches on the first account and never reopens |
| Setup POSTs are unauthenticated while no user exists | open | `app/api/setup/{general,auth,email,backup,github}/route.ts` skip `requireAdminAuth` when `needsSetup()`. On a fresh public box the first visitor can set GitHub OAuth, email and backup targets, then sign up as admin. |
| First signup becomes instance admin | open, by design | `lib/organizations/create-default-org.ts:17`. Concurrent signups give at most one admin. Whoever reaches the box first wins. |
| Open registration | fixed | defaults to `closed`, `lib/system-settings.ts:320`; `lib/auth/registration.ts:21` |
| GitHub webhook signature | fixed | mandatory secret, HMAC with `timingSafeEqual`, `app/api/v1/github/webhook/route.ts:35-55` |
| Auth rate limit bypass by rotating cookies | branch | `lib/api/with-rate-limit.ts:37` keys the auth tier by IP only |
| Auth rate limit keyed on first `X-Forwarded-For` | open, verify | `lib/api/with-rate-limit.ts:24`, `proxy.ts:28`. Safe only while Traefik strips client-sent forwarding headers. |
| Host header poisoning of auth links | not a boundary in prod | Better Auth reads `NEXT_PUBLIC_BETTER_AUTH_URL` (`docker-compose.yml:38`). Dev infers from the request. |
| Postgres and Redis published on every interface, Redis has no password | branch | `docker-compose.yml:155,173` now bind to `127.0.0.1`. Docker's publishing skips ufw. |
| Traefik dashboard | open, low | `--api.insecure=true` on `vardo-network`, not published (`docker-compose.yml:212`). Leaks every route to any routed app. |

## 2. Tenant A to tenant B

| Claim | Status | Evidence |
| --- | --- | --- |
| Org routes check membership and capability | fixed | `verifyOrgAccess`/`verifyAppAccess` with `can()`, `lib/auth/permissions.ts`; nested IDs scoped through the app or org lookup, `lib/api/verify-access.ts:21-24` |
| Route walker | partial | `tests/unit/api/route-authorization.test.ts:13,57` only scans `organizations/**` and only checks a guard name appears in the file, not per handler or capability |
| Any signed-in user links every GitHub App installation | branch | `app/api/v1/github/installations/sync/route.ts:16`, `callback/route.ts:51` now require an instance admin. Rows linked before this aren't removed. |
| Clone uses any installation of any org member | open | `lib/docker/deploy-steps/prepare-repo.ts:385-404`. A user in two orgs lends their installations to both. |
| Domain string injected into a Traefik rule | branch | PATCH accepted any string, `apps/[appId]/domains/route.ts:104`. Now validated there and in environment routes; `lib/docker/compose-inject.ts:120` and `lib/ssl/generate-config.ts:93` refuse non-hostnames. |
| Compose `traefik.*` labels claim another tenant's host or the console | fixed | #887 on `fix/887-label-hosts`: `lib/docker/label-hosts.ts` refuses `Host()` rules for hosts the org doesn't own, checked from `resolve-compose.ts` |
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
| API tokens | partial | carry the user's full live role, no capability scoping, `lib/auth/session.ts:48-73`; never instance admin, `lib/auth/admin.ts:8` |
| Any user can create an org and become its owner | open, product | `app/api/v1/organizations/route.ts:59-97`. The section 5 compose gaps that made owner mean host are fixed (#886). |

## 4. Untrusted input to execution

| Claim | Status | Evidence |
| --- | --- | --- |
| Fork PRs reach a build | fixed | `lib/git-integration/pull-request.ts:4` refuses forks and head/base mismatch; called before any build, `webhook/route.ts:154` |
| Self-preview gets secrets | not a boundary | only same-repo PRs reach it after the fork check |
| GitHub token in `.git/config` inside the build context | branch | was written into the origin URL; now a github.com-scoped header via env, `lib/git-integration/clone-auth.ts`, `prepare-repo.ts:409` |
| App env vars become the Nixpacks and Railpack process env | fixed | a member's `PATH` or `LD_PRELOAD` pointed the spawn at a binary in their cloned repo, running it in the console. App vars now reach builders only as `--env`, `lib/docker/deploy-steps/prepare-repo.ts:240` |
| Git URL transports | fixed | HTTPS only, `lib/docker/validate.ts:26` |
| Git clone to internal HTTPS hosts | open, low | `assertSafeGitUrl` doesn't check the host; git follows redirects |
| Push webhook deploys every app with that git URL in any org | open, low | `webhook/route.ts:89-94` doesn't scope by installation. Only rebuilds code that's already public to the cloner. |
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
| Slots deployed before #886 | open | `start`, `restart` and `recreate` rerun `up` on existing slot files without the check |

## 6. Secret exposure

| Claim | Status | Evidence |
| --- | --- | --- |
| Env vars in API responses | fixed | masked unless `?reveal=true`, logged, `apps/[appId]/env-vars/route.ts:61-80` |
| Backup target credentials | fixed | `lib/backups/target-config.ts:139` |
| Notification webhook `url` returned in plaintext | open, low | only `secret` and Slack URL are masked, `lib/notifications/mask-config.ts:8-21`. Discord URLs carry a token. |
| Deploy log masking | partial | one sanitized sink, `lib/docker/deploy-logger.ts:54-60`, but pattern-only: app env values aren't passed to `redactSecrets`, so a bare value or a name like `STRIPE_KEY` leaks, `lib/redact.ts:8-45` |
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
| Registry token realm from `WWW-Authenticate` | open, blind | `lib/docker/image-updates/registry.ts:119-136` fetches any realm |
| Backup S3 `endpoint` | open, verify | unvalidated string, `lib/backups/target-config.ts:37` |
| Git clone host | open, low | see section 4 |
| Mesh hub URL from an invite | not a boundary | instance admin only, `app/api/v1/admin/mesh/join/route.ts:81` |

## 8. A compromised app container

Same starting point as Dokploy: an app's own image CVE runs code inside that app's container. Vardo neither adds nor removes much by default.

Narrows:
- No socket mount in generated compose; host-access keys refused for untrusted orgs.
- Only Traefik-routed services join `vardo-network`; others stay on the project network.
- A default memory limit per QoS tier (`lib/docker/compose-inject.ts:382-414`).
- Postgres and Redis no longer published beyond loopback (this branch).

Widens or leaves open:
- `vardo-network` includes the console, Traefik and WireGuard, so a routed app reaches `vardo-frontend:3000` and the Traefik API on `:8080` directly.
- No `no-new-privileges`, `cap_drop`, `read_only`, non-root `user` or `pids_limit`; `pids_limit` is dropped even when set (`lib/docker/compose-validate.ts:313`). No default CPU limit. A cryptominer gets every core.
- Redis has no password, so anything that joins `vardo_internal` owns it.
