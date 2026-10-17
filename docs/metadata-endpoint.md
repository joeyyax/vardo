# Metadata endpoint

An app's containers can read what Vardo knows about them from `http://vardo.internal/v1/self`: the serving deploy, the container's memory and CPU, restarts, OOM kills, uptime measured from outside, certificate expiry and backup state. It's on by default. Turn it off per app under **Networking → Metadata endpoint**; the change applies within 5 seconds.

```sh
curl -s -H 'Vardo-Metadata: 1' http://vardo.internal/v1/self
```

It answers only on the app's project network (`vardo-p-<project>-<environment>`). An app outside a project, a service with `network_mode` other than `service:`, and a host-network app can't reach it.

**Don't make a health check depend on it.** It's served by the console. When the console is down or restarting, the endpoint answers 502 and your app has to keep running. Read it for dashboards, logs and self-reporting, cache what you read, and treat any failure as "unknown".

## Requests

- `GET` or `HEAD` only, with the header `Vardo-Metadata: 1`. Without it the answer is 400, so an SSRF bug that fetches a URL for a user can't read it.
- A request carrying `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or `Via`, or one sent in proxy form (`GET http://vardo.internal/v1/self`), is refused with 400.
- No token. The caller is identified by its container's address on the project network, so a container reads only its own app's data.
- Each container address gets 5 requests a second, bursting to 20. Past that the answer is 429. Facts are cached for 5 seconds, so polling faster gains nothing.

| Status | Meaning |
| --- | --- |
| 200 | The payload below |
| 400 | Missing header, forwarding headers or a proxy-form request |
| 403 | The address isn't one Vardo container on this project network |
| 404 | The app turned the endpoint off, or any path but `/v1/self` |
| 429 | Rate limited |
| 502, 503 | The console or Docker is unavailable |

## Payload, v1

`version` is `1`. Fields are added within a version; a removed or renamed field gets a new version. A value Vardo doesn't have is `null`.

```json
{
  "version": 1,
  "generatedAt": "2026-10-17T20:14:18.000Z",
  "app": { "id": "app_123", "name": "shop", "displayName": "Shop", "service": "web", "url": "https://shop.example.com" },
  "environment": { "name": "production", "type": "production" },
  "deploy": { "id": "dep_456", "sha": "4f9a507b…", "branch": "main", "deployedAt": "2026-10-17T19:02:11.000Z", "slot": "green" },
  "resources": {
    "container": { "id": "8c1e…", "memoryUsedBytes": 201326592, "memoryLimitBytes": 536870912, "cpuPercent": 3.2 },
    "restarts": { "count": 2, "since": "2026-10-16T08:00:00.000Z" },
    "oomKills": { "lastHour": 0, "lastAt": null }
  },
  "uptime": { "state": "up", "uptime24h": 100, "uptime30d": 99.93, "medianResponseMs": 142, "lastCheckedAt": "2026-10-17T20:13:40.000Z" },
  "certs": [{ "domain": "shop.example.com", "daysLeft": 61, "expiresAt": "2026-12-17T11:20:00.000Z", "status": "ok", "checkedAt": "2026-10-17T18:00:00.000Z" }],
  "backups": { "state": "ok", "lastSuccessAt": "2026-10-17T02:04:51.000Z" }
}
```

| Field | Meaning |
| --- | --- |
| `app` | The app the container belongs to. A compose service with its own child app gets that app; `service` is the compose service |
| `deploy` | The serving deploy, with the same values as the [deploy variables](deploy-variables.md). Null before the first recorded deploy. `sha` is null for an app without a git repo; `slot` is null for a local environment |
| `resources.container` | This container, from the metrics collector. Null with metrics off or before the collector has seen it. `memoryLimitBytes` is null with no limit |
| `resources.restarts` | Docker's restart count across the app's containers since `since`, the oldest container's creation. Null before the reconciler has read it |
| `resources.oomKills` | Kills in the last hour across the app, and the time of the latest kill Vardo still holds |
| `uptime` | From the app's uptime monitors. `state` is `up`, `degraded`, `down`, `unknown` or `stopped`; percentages are 0–100; `medianResponseMs` is over 24 hours. Null without a monitor |
| `certs` | Each enabled domain with a certificate check: whole days to expiry and the check's verdict (`ok`, `expiring`, `expired`, `not-issued`, `unknown`) |
| `backups.state` | `ok`, `overdue` (a job missed two runs), `on-hold` (overdue only because the app is stopped) or `none` (no enabled job covers it). `lastSuccessAt` is the latest successful backup |

The payload never holds env values, secrets, compose content or anything from the encrypted snapshots.

## How it works

`vardo-metadata` is an nginx container the console runs and keeps on every project network as `vardo.internal`. It forwards only `/v1/self` to the console over `vardo-metadata`, a network only the two share. It stamps each request with the caller's address and the address it arrived on, overwriting anything the app sent. The console accepts that only from the proxy's own address, then looks the caller up in Docker: exactly one running container must hold that address on the project network the request arrived on, carry the labels Vardo writes at deploy, and belong to an app in that project and environment. Anything else is a 403.

An address on one Docker bridge can't be claimed from another, so a container can't read another project's data. Apps in the same project and environment share a network and are one trust domain, as they are for reaching each other's services. A container there with `NET_RAW` could, in principle, ARP-spoof a neighbor's address.

The proxy runs as an unprivileged user with every capability dropped, a read-only filesystem, a 32 MB memory limit and IP forwarding off. The console isn't on any project network.
