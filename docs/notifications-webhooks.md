# Notifications: incidents and webhooks

Every problem Vardo notifies about belongs to an incident with a stable id. A receiver opens one ticket when the incident opens, updates it while it holds and closes it on recovery.

## Incidents

An incident covers one subject and one kind of problem. Its `key` is deterministic: `<subject type>:<subject>:<kind>`.

| Kind | Subject | Opens | Resolves |
| --- | --- | --- | --- |
| `host.memory`, `host.swap`, `host.cpu`, `host.load`, `host.disk` | `host:local` | Threshold held | Back under the clear margin |
| `app.restart-loop`, `app.unhealthy`, `app.memory-limit` | `app:<appId>` | Condition held | Condition cleared |
| `app.oom` | `app:<appId>` | Kernel killed it for memory | The kill ages out |
| `app.anomaly`, `app.new-port`, `app.new-process` | `app:<appId>` | Far outside its baseline | Back inside it |
| `backup.failure` | `volume:<kind>:<app>/<volume>` | A backup failed | The next backup of that volume succeeds |
| `cron.failure` | `cron-job:<jobId>` | A run failed | A run succeeds |
| `deploy.failed` | `app:<appId>/<environmentId>` | A deploy failed or timed out | The next deploy succeeds |
| `system.service-down` | `service:<name>` | A core service failed three checks in a row | It answers again, with a recovery notice |
| `system.cert-expiring` | `domain:<domain>` | The served certificate is close to expiry or expired | A renewed certificate is served, with a recovery notice |

An incident that comes back within 30 minutes of resolving reopens with the same id. After that, it's a new incident.

Severity can rise and fall while an incident is open. A rise sends an update; a fall is recorded and shows on the next notice. The usual throttles still apply: an incident sends once when it opens, once if it gets worse and once when it resolves.

## Webhook payload

Version 2 adds `version`, `id` and `incident`. Every field from version 1 is still there.

| Field | Meaning |
| --- | --- |
| `version` | Payload schema, `2`. |
| `id` | Stable per notice. A retry sends the same `id`. |
| `type` | The event type, as before. |
| `timestamp` | When this delivery was sent. |
| `incident` | Present when the notice is about one incident. |
| `quiet` | `true` on a resolution email and push skip. Webhooks still get it. |

`incident` carries structured fields and Vardo's own wording only. It never holds log lines, error output or env values.

| Field | Meaning |
| --- | --- |
| `id` | `inc_…`, stable for the incident's life. |
| `key` | The deterministic key above. |
| `kind` | The kind, e.g. `app.restart-loop`. |
| `state` | `open` or `resolved`. |
| `transition` | What this notice did: `opened`, `updated` or `resolved`. |
| `reason` | On updates: `escalated`, `reopened` or `repeated`. |
| `severity`, `peakSeverity` | `warning` or `critical`, now and at worst. |
| `subject` | `{ type, id }`. |
| `appId` | When the subject belongs to an app. |
| `title` | The wording when it opened. Constant for the incident. |
| `openedAt`, `updatedAt`, `resolvedAt` | ISO times. `resolvedAt` is `null` while open. |
| `durationMs` | Open to resolved, on resolution. |
| `updates` | Notices sent after the opening one. |
| `url` | The console page for the subject. |

An `alert.fired` or `alert.resolved` notice that covers several incidents arrives as one POST per incident, each with one entry in `alerts`, its own `incident` and an `id` of `<notice id>:<incident id>`.

### Open, update, resolve

```json
{
  "version": 2,
  "id": "evt_q8d1v0m2xk3t7c9a4b6n",
  "type": "alert.fired",
  "title": "Shop keeps restarting",
  "message": "Shop keeps restarting",
  "alerts": [{ "type": "app.restart-loop", "about": "app_1", "severity": "warning", "title": "Shop keeps restarting", "detail": "…" }],
  "incident": {
    "id": "inc_3n8w0d2k7q1v5c9x4m6b",
    "key": "app:app_1:app.restart-loop",
    "kind": "app.restart-loop",
    "state": "open",
    "transition": "opened",
    "severity": "warning",
    "peakSeverity": "warning",
    "subject": { "type": "app", "id": "app_1" },
    "appId": "app_1",
    "title": "Shop keeps restarting",
    "openedAt": "2026-10-10T10:00:00.000Z",
    "updatedAt": "2026-10-10T10:00:00.000Z",
    "resolvedAt": null,
    "updates": 0,
    "url": "https://vardo.example.com/apps/app_1"
  },
  "timestamp": "2026-10-10T10:00:01.204Z"
}
```

It gets worse:

```json
{ "version": 2, "id": "evt_…", "type": "alert.fired", "incident": { "id": "inc_3n8w0d2k7q1v5c9x4m6b", "state": "open", "transition": "updated", "reason": "escalated", "severity": "critical", "peakSeverity": "critical", "updates": 1, "…": "…" } }
```

It recovers:

```json
{ "version": 2, "id": "evt_…", "type": "alert.resolved", "incident": { "id": "inc_3n8w0d2k7q1v5c9x4m6b", "state": "resolved", "transition": "resolved", "resolvedAt": "2026-10-10T12:00:00.000Z", "durationMs": 7200000, "…": "…" } }
```

### Receiving

1. Drop a body whose `id` you've already processed. Retries repeat it.
2. No `incident`: it's a one-off event (a deploy, an update, a digest). Handle it as before.
3. Look up your ticket by `incident.id`.
4. `transition: "opened"`: create the ticket.
5. `transition: "updated"`: update the ticket, and reopen it when `reason` is `reopened`. Create it if you missed the opening.
6. `transition: "resolved"`: close the ticket with `durationMs`.

Sign-check the body with `X-Signature-256` as before.

## Email

Emails about one incident share a thread. The opening email's Message-ID is `<inc_…@your-console-host>`; updates and the resolution carry it in `In-Reply-To` and `References`. The subject stays the incident's opening title, with `✓ Resolved ·` on the resolution.

| Provider | Threading |
| --- | --- |
| SMTP | Full: the opening email carries the root Message-ID. |
| Pouch, Resend, Postmark | The provider sets Message-ID, so every email references the root and clients group them by it. A Pouch domain that refuses custom headers gets the email without them. |
| Mailpace | Through its `inreplyto` and `references` fields. |

Gmail also wants matching subjects, so a resolution starts a new thread there.

Notices covering several incidents aren't threaded.

## Push channels

| Channel | On update and resolution |
| --- | --- |
| ntfy | Publishes with `sequence_id` set to the incident id, so servers that support it replace the earlier notification. Older servers post a new one. |
| Discord | The resolution edits the opening message in place. Updates post a new message. A deleted opening message gets a new one. |
| Telegram | Updates and the resolution reply to the opening message. |
| Pushover | No updates in its API: each notice is a new message with the same title. |
| Slack | A new message each time. Quiet resolutions aren't sent. |

## One-off events

A `deploy.success` that follows a failure carries that failure's incident, resolved. A `deploy.failed` while one is open updates it with `reason: "repeated"`.

These stay one-off with a stable `id` and no `incident`: other successful deploys, deploy incomplete and rollbacks, backup summaries and run starts, security scan findings, file exposure and claimed domains, disk write alerts, volume drift, auto-restarts, watchdog restarts, Vardo lifecycle and updates, invitations and the digest.
