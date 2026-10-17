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
| `error` | One of `timeout dns refused reset tls cert-expired cert-expiring status keyword invalid private-address blocked unknown` |
| `certDaysLeft` | Whole days to certificate expiry (TLS checks) |

Raw error strings and response bodies never appear. `private-address` marks a check skipped because the host resolved to a private address; `blocked` marks a check the outbound policy refused. Both count as no data.

`kind: "hourly"` carries `monitorId` and one `bucket`: `start` (epoch ms, on the hour), `minutesUp`, `minutesDown`, `minutesUnknown`, `uptimePct` (two decimals or null) and `medianLatencyMs` (or null).

`kind: "watch"` carries `monitors`, the checks the signer asks a vantage point to run: `monitorId`, `check`, `intervalSec` and `path` (`public` or `mesh`). A monitor whose host resolves only to private addresses is listed with `path: "mesh"`; one with a public address with `path: "public"`. A mesh check is run through the signer's WireGuard tunnel: the vantage point connects to the signer's tunnel address and sends the check's host as the Host header and SNI name. Other monitors don't appear.

## Paths

`path` was added to version 1 compatibly. A reader treats a result or watch entry without it as `public` on an external vantage point and `local` on the local one. The owner accepts a result only on the path it served for that monitor. Verifiers that don't know `path` ignore it, and a mesh entry they receive is skipped as a private address.

## Rules

- A vantage point is failing on a path after two failed checks in a row there.
- Public external results decide a monitor. With none current, mesh results decide; with none of those, the local one does and the state is `localOnly`.
- The deciding results are `up` with none failing, `down` with most failing and `degraded` with some failing.
- A result outside the deciding set that fails while the deciders are up is `degraded`. A failing mesh verdict with the local check passing is `degraded`.
- Public uptime counts public-path results only.
- Missing data is `minutesUnknown`, never up.
