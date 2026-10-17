# Uptime record format, v1

A vantage point signs what it measured. The owner stores records as received and can't change them.

## Envelope

```json
{ "payload": "<JSON text>", "sig": "<base64>" }
```

`sig` is an Ed25519 signature over the UTF-8 bytes of `"vardo-uptime/v1\n" + payload`. The payload text is signed as written; verifiers parse it after the signature holds. Keys are PEM (SPKI public, PKCS#8 private).

## Payloads

Every payload has `v: 1`, `kind`, `vantageId` and `issuedAt` (epoch ms). A verifier rejects other versions.

`kind: "results"` carries `results`, an array of:

| Field | Meaning |
| --- | --- |
| `monitorId`, `vantageId` | What was checked and where from |
| `path` | The route the check took: `public`, `mesh` or `local` |
| `at` | Epoch ms the check started |
| `ok`, `latencyMs` | Outcome and duration |
| `status` | HTTP status, when a response came back |
| `error` | One of `timeout dns refused reset tls cert-expired cert-expiring status keyword no-route invalid private-address blocked unknown` |
| `certDaysLeft` | Whole days to certificate expiry (TLS checks) |
| `cache` | The cache that answered an HTTP check instead of the origin: `cloudflare vercel cloudfront fastly proxy cache`. Absent when the origin answered |
| `bytes` | Body size of an HTTP check: Content-Length when sent, else the bytes read, capped at 64 KiB |

Raw error strings and response bodies never appear. `private-address` marks a check skipped because the host resolved to a private address; `blocked` marks a check the outbound policy refused. Both count as no data. `no-route` marks a response carrying `x-vardo-route: none`, which a Vardo console sets only on the page it serves for a host with no route; it counts as failing.

`kind: "hourly"` carries `monitorId` and one `bucket`: `start` (epoch ms, on the hour), `minutesUp`, `minutesDown`, `minutesUnknown`, `uptimePct` (two decimals or null) and `medianLatencyMs` (or null).

`kind: "watch"` carries `monitors`, the checks the signer asks a vantage point to run: `monitorId`, `check`, `intervalSec` and `path` (`public`). An HTTP `check` may carry `method` (`GET`, `HEAD` or `POST`, sent without a body); without it the check is a GET. Only monitors with a public address appear. Older signers also listed private monitors with `path: "mesh"`, to be checked through their WireGuard tunnel; a vantage point drops those entries and never checks them.

`kind: "report"` carries `monitors`, the signer's own view of the monitors a watching peer doesn't check: those with no public address, or with request headers the owner keeps to itself. Each entry is:

| Field | Meaning |
| --- | --- |
| `monitorId` | The owner's monitor id |
| `host` | The checked host name or address, nothing else: no scheme, credentials, port, path or query |
| `state` | `up`, `degraded`, `down` or `unknown`, as the owner evaluates it, before damping |
| `downSince` | Epoch ms it went down, while `down` |
| `latencyMs` | Median response time of the successful checks in the last 15 minutes, or null |
| `container` | `healthy`, `unhealthy` or `crash-looping` for a monitor of an app; null otherwise |
| `outages` | Up to 20 of the last 24 hours' outages, `{ start, end }` (epoch ms; `end` null while ongoing) |
| `quiet` | The owner silenced alerts for it: muted, in maintenance or waiting on review |

Response bodies, headers, keywords and error strings never appear. A reader refuses the whole report when any entry has a field beyond these, or a `host` that isn't a bare name or address.

## Schedule

A watch entry may carry `periodSec` and `offsetMs`. The vantage point runs the check once per `periodSec`, at `offsetMs` into each period (`floor((now - offsetMs) / period)` advancing). When N vantage points share a monitor, each is given `periodSec = intervalSec x N` and an offset of the monitor's phase plus its place in the sorted vantage ids times the interval, so the monitor is checked about once per interval in all. Without them, a vantage point checks every `intervalSec`. The owner judges a vantage point current for three of its own periods (at least 90 seconds).

## Paths

`path` was added to version 1 compatibly. A reader treats a result or watch entry without it as `public` on an external vantage point and `local` on the local one. The owner accepts external results on the `public` path only. `mesh` remains readable for results stored before mesh checks were retired.

`method`, `cache`, `bytes` and the `no-route` error were added to version 1 the same way. A reader that doesn't know `method` runs a GET.

## Reports

`report` was added to version 1 compatibly. An owner sends one to each linked peer it lets check it, once a minute, over the signed mesh call to `/api/v1/mesh/uptime/reports`, with its vantage identity beside the record. The peer accepts it only while it watches the owner, under the key the owner already announced to it (or the first one it sees), with `issuedAt` within 10 minutes behind and 5 minutes ahead of its own clock and newer than the last report it took. It keeps the latest one as received.

The peer feeds each entry's `state` through its own damping, so a reported `down` is announced after it holds 3 minutes. A report that hasn't arrived for 150 seconds is stale: the peer then asks the owner for its watch list, and drops the report if the owner refuses it. Otherwise the stale report alone raises the peer's verdict on the owner, damped like any other; the tunnel, heartbeat and public URL only choose its wording: "stopped reporting" while the owner still answers, the link-down and instance-down verdicts while it doesn't.

## Rules

- A vantage point is failing on a path after two failed checks in a row there.
- Public external results decide a monitor. With none current, mesh results (from before they were retired) decide; with none of those, the local one does and the state is `localOnly`.
- The deciding results are `up` with none failing, `down` with most failing and `degraded` with some failing.
- A result outside the deciding set that fails while the deciders are up is `degraded`. A failing mesh verdict with the local check passing is `degraded`.
- Public uptime counts public-path results only.
- Missing data is `minutesUnknown`, never up.
