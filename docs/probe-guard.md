# Probe guard

Vardo turns away well-known exploit probes before they reach an app, bans addresses that keep probing and can share those bans with linked instances. It's on for every app by default. Turn it off or add exceptions in the app's **Security** tab; instance settings and every active ban are under **Admin → Security**.

## How it works

The console writes one Traefik file, `vardo-probe-guard.yaml`, in the dynamic directory (`lib/probe-guard/traefik-file.ts`). It holds high-priority routers per guarded app and two shared ones:

| Router | Priority | Matches | Answer |
| --- | --- | --- | --- |
| `vardo-guard-banned-*` | 1,000,000,040 | A banned address on any guarded host | 403 |
| `vardo-guard-canary-*` | 1,000,000,030 | A decoy marker in a credential header or query value | 403, then a ban |
| `vardo-guard-<app>-trap-*` | 1,000,000,020 | A trap path | 404, then a ban |
| `vardo-guard-<app>-probe-*` | 1,000,000,010 | A probe path (`lib/probe-guard/rules.ts`) | 403, or 404 for `.env`, `.git` and backups |
| `vardo-guard-<app>-robots-*` | 1,000,000,000 | `/robots.txt`, when the app opted in | Trap lines as `Disallow` |

Every router sends the request to the console's `vardo@docker` service at `/probe-guard/<kind>`, with `X-Vardo-Guard` set to a key derived from `ENCRYPTION_MASTER_KEY`. The console answers only requests that carry it. Answers are short plain text with `Cache-Control: no-store`, never mention the app or its stack, and don't depend on the app being up. With **Humor in probe responses** off, the body is `Forbidden` or `Not Found`.

The file is rewritten on every settings change and ban, and each minute by the `probe-guard` loop, which drops expired bans and picks up new domains. Saved settings apply without a redeploy.

## Bans

The console counts probe hits per client address in Redis. Five within 10 minutes bans the address for an hour; each repeat within 30 days doubles that, up to 24 hours. A trap hit or a used decoy credential bans at once. All of these are instance settings.

Vardo never bans private, loopback, link-local, CGNAT (Tailscale) or mesh addresses, its own public address, `VARDO_TRUSTED_PROXIES`, linked instances' addresses, Cloudflare's edge ranges or anything on the **Never ban** list.

### Never ban

Admins keep up to 200 IPs or CIDRs (no broader than /8 for IPv4 or /16 for IPv6) under **Admin → Security → Never ban**. Listed addresses are never banned, accepted from a linked instance, reported or blocked by a blocklist, and adding one lifts any ban it covers. Their probes still get the guard's 403 or 404 but never count. **Skip the probe guard entirely** also excludes the address from the probe, trap and canary routers, matched on the TCP peer, the last `X-Forwarded-For` hop and `Cf-Connecting-Ip` from Cloudflare, a trusted proxy or a local network. IPv6 ranges whose prefix isn't a multiple of 16 match the TCP peer only.

### Blocklists

Two sources, both off by default and fetched about once a day:

- **AbuseIPDB blocklist** (needs the API key): up to 10,000 addresses at or above the confidence threshold (default 90, minimum 75; the free tier only returns 100). Each becomes a 24-hour `blocklist` ban, refreshed daily and never permanent.
- **Spamhaus DROP**: hijacked and criminal netblocks from `drop_v4.json` and `drop_v6.json`. Ranges that overlap any never-ban range are skipped.

The guard file renders up to 1,000 addresses: permanent bans, then local bans, then at most 500 blocklist bans by confidence. DROP ranges render as up to 2,000 `ClientIP` matchers, which match the TCP peer only. Writing CIDRs into the forwarded-header regex would make it large and slow, so a proxied client in a DROP range is caught only when it reaches a guard route, where the responder checks it against the ranges in memory.

### Abuse reporting

With **Report confirmed abuse** on, the console reports to AbuseIPDB: exploit-rule hits (Laravel Ignition, PHPUnit, path traversal, router exploits, sensitive Actuator paths) on sight, and trap fetches, decoy credential use and credential hunting (env files, cloud credentials, SSH keys) when they end in a ban. Plain threshold bans of other paths, shared bans and blocklist bans aren't reported. Each address is rechecked against the never-ban rules at send time.

Reports go from a Redis queue drained by the `abuse-report` loop: one per address per 15 minutes, a daily cap (default 500) and a backoff on 429 that honors `Retry-After`. Comments carry rule labels and sanitized paths only, with no query strings and no segment that looks like a host, address, email, token or the name of any app, project, org or domain on the instance.

### Behind Cloudflare

The ban router matches an address three ways:

- `ClientIP(...)`: the TCP peer, for direct traffic.
- `HeaderRegexp(X-Forwarded-For, ...)`: any hop. Traefik keeps `X-Forwarded-For` only from its trusted IPs (Cloudflare's ranges and `VARDO_TRUSTED_PROXIES`), so behind Cloudflare it holds the real client.
- `HeaderRegexp(Cf-Connecting-Ip, ...)`: covers `cloudflared` tunnels, whose peer Traefik doesn't trust.

The banned address is always one of these, so a client can't slip a ban by sending its own headers. A direct client that forges `Cf-Connecting-Ip` with a banned address only blocks itself. Bans aren't pushed to Cloudflare.

## Traps and the decoy

Trap paths (default `/admin-backup/`, `/.old/`, `/private/db.sql`) appear as `Disallow` lines in the console's robots.txt and, for apps that opt in, in a robots.txt Vardo serves for the app. Vardo won't take over an app's robots.txt while the app serves its own.

`<first trap folder>.env` serves a decoy `.env`. Each fetching address gets its own marker, and every value carries it in a form no real service accepts: `AKIA_<MARKER>_EXAMPLE`, a `.invalid` database host and `example_` secrets. Anyone who later sends a marker in `Authorization`, `Cookie`, an API key header or a common credential query parameter is banned and logged as **canary used**.

Vardo keeps the address, path, marker id and times. It never keeps what a client sent.

## Sharing bans

With **Share bans with linked instances** on, new local bans go to every directly linked instance over the signed mesh channel (`POST /api/v1/mesh/probe-bans`). An instance applies them only when its own sharing setting is on, keeps the sender's expiry (capped at its own longest ban) and never sends them on.

## Activity

Bans, trap hits and canary use leave quiet activity rows on the app. Counts show on the app's Security tab and the admin Security page. Nothing sends alerts or email.

Both pages take a range (1h, 24h, 7d, 30d, 90d or all time, in `?range=`, default 7d) for the summary, recent bans, what was probed and top sources. Ban rows and probe events are kept for 90 days, so all time means everything retained. Probe events are capped per address per window; Redis keeps exact hit counts per rule, per hour (50 hours) and per day (92 days), for the instance and each app. What was probed reads those counts, and falls back to events, marked "approximate before <date>", for the stretch before counting began. The admin page adds each rule hits and the bans that tried it.
