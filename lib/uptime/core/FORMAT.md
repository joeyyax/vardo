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
| `at` | Epoch ms the check started |
| `ok`, `latencyMs` | Outcome and duration |
| `status` | HTTP status, when a response came back |
| `error` | One of `timeout dns refused reset tls cert-expired cert-expiring status keyword invalid private-address blocked unknown` |
| `certDaysLeft` | Whole days to certificate expiry (TLS checks) |

Raw error strings and response bodies never appear. `private-address` marks a check skipped because the host resolved to a private address; `blocked` marks a check the outbound policy refused. Both count as no data.

`kind: "hourly"` carries `monitorId` and one `bucket`: `start` (epoch ms, on the hour), `minutesUp`, `minutesDown`, `minutesUnknown`, `uptimePct` (two decimals or null) and `medianLatencyMs` (or null).

`kind: "watch"` carries `monitors`, the checks the signer asks a vantage point to run: `monitorId`, `check` and `intervalSec`. Only monitors with a public address appear.

## Rules

- A vantage point is failing after two failed checks in a row.
- A monitor is down when most external vantage points are failing. With none, the local one decides and the state is `localOnly`.
- Missing data is `minutesUnknown`, never up.
