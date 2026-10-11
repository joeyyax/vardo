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

Vardo never bans private, loopback, link-local, CGNAT (Tailscale) or mesh addresses, its own public address, `VARDO_TRUSTED_PROXIES`, linked instances' addresses or Cloudflare's edge ranges.

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
