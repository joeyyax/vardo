# Backup & Restore Guide

Vardo backs up Docker volumes by archiving them with `tar` and uploading the archive to a storage target. Backups are driven by scheduled jobs that run on a per-minute tick with distributed locking to prevent double-fire.

## Architecture overview

```
Backup Scheduler (60s tick)
  └── tickBackupJobs()
        └── for each enabled job due to run:
              └── runBackup(jobId)
                    └── for each app in the job:
                          └── for each persistent volume:
                                1. Find Docker volume (blue slot → green slot)
                                2. tar czf volume.tar.gz via alpine container
                                3. Upload to storage target
                                4. Record result in backup_run table
```

## Backup targets

A backup target defines where backups are stored. Targets are configured per-organization, or at the system level as a shared default.

### Supported target types

| Type | Description |
|---|---|
| `s3` | AWS S3 or any S3-compatible endpoint |
| `r2` | Cloudflare R2 (S3-compatible) |
| `b2` | Backblaze B2 (S3-compatible) |
| `ssh` | Remote server via SSH + SCP |

S3, R2, and B2 all go through the same S3-compatible API adapter. The only difference is the endpoint URL.

### S3 / R2 / B2 configuration

| Field | Description |
|---|---|
| `bucket` | Bucket name |
| `region` | Region (e.g. `us-east-1`, `auto` for R2) |
| `accessKeyId` | Access key ID |
| `secretAccessKey` | Secret access key |
| `endpoint` | Custom endpoint URL (required for R2, B2, Minio) |
| `prefix` | Optional path prefix inside the bucket |

**Cloudflare R2 example:**
```json
{
  "bucket": "my-backups",
  "region": "auto",
  "accessKeyId": "abc123",
  "secretAccessKey": "secret",
  "endpoint": "https://<account-id>.r2.cloudflarestorage.com"
}
```

**Backblaze B2 example:**
```json
{
  "bucket": "my-backups",
  "region": "us-west-004",
  "accessKeyId": "keyId",
  "secretAccessKey": "applicationKey",
  "endpoint": "https://s3.us-west-004.backblazeb2.com"
}
```

### SSH configuration

| Field | Description |
|---|---|
| `host` | Remote hostname |
| `username` | SSH username |
| `path` | Remote directory path for backups |
| `port` | SSH port (default: 22) |
| `privateKey` | PEM-encoded private key (optional, falls back to SSH agent) |

SSH targets support backup and restore operations, but do not support pre-signed download URLs. Downloads go through the Vardo server.

> **Note:** SSH targets work for backups but are not recommended for production. There is no redundancy, and if the remote server is lost, so are the backups. Use an object storage target for anything you care about.

## System-level vs org-level targets

A backup target with `organizationId = null` is a system-level target. It serves as a global fallback for all organizations.

**Resolution order when looking for a backup target:**
1. Org-level default target (`isDefault: true` for the org)
2. Any org-level target (non-default)
3. System-level target (`organizationId IS NULL`)

If no target exists anywhere, backups are skipped silently.

### Creating a system-level target from configuration

Set backup storage credentials in `vardo.yml` (or via database settings) and Vardo will auto-create a system-level target named "System default" on startup:

```yaml
backup:
  type: r2
  bucket: my-backups
  region: auto
  access_key: abc123
  secret_key: secret
  endpoint: https://<account-id>.r2.cloudflarestorage.com
```

See [configuration](configuration.md) for the full config reference.

## Backup jobs

A backup job defines the schedule, retention policy, and which apps to back up.

### Job fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Display name |
| `schedule` | string | Cron expression (e.g. `0 2 * * *`) |
| `enabled` | boolean | Whether the job runs |
| `targetId` | string | Backup target to write to |
| `keepAll` | boolean | Retain all backups forever |
| `keepLast` | integer | Keep N most recent backups |
| `keepHourly` | integer | Keep N hourly backups |
| `keepDaily` | integer | Keep N daily backups |
| `keepWeekly` | integer | Keep N weekly backups |
| `keepMonthly` | integer | Keep N monthly backups |
| `keepYearly` | integer | Keep N yearly backups |
| `notifyOnSuccess` | boolean | Send notification on success |
| `notifyOnFailure` | boolean | Send notification on failure (default: true) |

### Auto-created backup jobs

When an app with persistent volumes is deployed and a backup target exists, Vardo automatically creates a daily backup job:

- Schedule: `0 2 * * *` (2 AM)
- Retention: keep last 1, keep 7 daily, keep 1 weekly, keep 1 monthly
- Notify on failure: enabled
- Name: `Auto: {appName}`

The job is only created once. If the app already has a backup job, nothing happens.

### Staggered backup scheduling

> **Planned** — Tracked in [#292](https://github.com/joeyyax/vardo/issues/292)

Auto-created backup jobs currently all use a fixed `0 2 * * *` schedule (2 AM). When many apps are backed up on the same instance, this creates a burst of concurrent backup activity. Staggered scheduling will distribute auto-created jobs across a configurable window (e.g. 1 AM – 5 AM) to spread the I/O load.

This will not affect manually created jobs with custom cron expressions — only the auto-created jobs will be staggered.

## What gets backed up

Vardo backs up **Docker named volumes** marked as `persistent: true` in the volumes table.

For each persistent volume, it:
1. Finds the Docker volume — checks `{appName}-blue_{volumeName}` first, then `{appName}-green_{volumeName}`.
2. Runs an Alpine container that tars the volume contents: `tar czf /backup/volume.tar.gz -C /data .`
3. Uploads the archive to the storage target.

The storage path follows this pattern: `{orgSlug}/{appName}/{volumeName}/{timestamp}.tar.gz`

Volumes that don't have a corresponding Docker volume (e.g. never deployed) are skipped and recorded as failed.

### Backup strategy per volume type

> **Planned** — Tracked in [#331](https://github.com/joeyyax/vardo/issues/331)

Currently all volumes are backed up the same way: `tar czf`. This works for generic volumes (file storage, user uploads) but is not ideal for database volumes, where a consistent database dump (`pg_dump`, `mysqldump`) is safer than a filesystem snapshot of live database files.

When implemented, volumes will be tagged by type (`database`, `generic`). Database volumes will use the appropriate dump tool for a consistent, importable backup. Generic volumes will continue to use `tar`. The restore path will handle both formats automatically.

### What is not backed up

- Non-persistent volumes (ephemeral)
- The Vardo database itself (see [Vardo database backup](#vardos-own-database) below)
- Application code (that comes from git)
- Docker images

## Scheduler and distributed locking

The backup scheduler runs a tick every 60 seconds. On each tick:

1. Load all enabled backup jobs.
2. For each job, check if `shouldRunNow(job.schedule, now)` returns true.
3. Acquire a distributed Redis lock: `lock:backup:{jobId}:{minuteTimestamp}` with a 61-second TTL. If the lock is already held, skip — another instance already picked up this job.
4. Check if the job already has a backup in `running` status. If so, skip.
5. Mark `lastRunAt` before executing to prevent concurrent double-fire.
6. Execute the backup.

This means backups fire at most once per minute per job, even across multiple server instances.

## Storage path

Archives are stored at: `{orgSlug}/{appName}/{volumeName}/{ISO-timestamp}.tar.gz`

Example: `acme/postgres/data/2024-01-15T02-00-00-000Z.tar.gz`

The timestamp uses dashes instead of colons (`:`) because some storage systems don't allow colons in object keys.

## Restore process

To restore a backup:

1. Download the archive from the storage target.
2. Find the Docker volume for the app (blue slot → green slot; create blue if neither exists).
3. Run an Alpine container that clears the volume and extracts the archive:
   ```
   rm -rf /data/* /data/.[!.]*
   tar xzf /backup/volume.tar.gz -C /data
   ```

Restoring replaces the entire volume contents. The app is not automatically restarted — restart it manually after restore to pick up the new data.

### Download URLs

For S3-compatible targets, Vardo generates a pre-signed URL (1-hour expiry) for direct download. For SSH targets, the download streams through the Vardo server.

## Vardo's own database

> **Note:** Auto-backup of Vardo's own PostgreSQL database is planned but not yet implemented. For now, back up the Postgres volume (`/var/lib/postgresql/data`) using a standard backup job, or use your hosting provider's database backup feature.

## Backup history

Every backup attempt creates a record in the `backup` table:

| Status | Meaning |
|---|---|
| `pending` | Not yet started |
| `running` | In progress |
| `success` | Completed, archive uploaded |
| `failed` | Error during archive or upload |
| `pruned` | Retained beyond the retention window and deleted |

Each record stores: job ID, app ID, target ID, volume name, archive size, storage path, timestamped log, start/finish times.

## Notifications

Backup jobs send notifications based on their settings:

- **On failure**: Sent by default. Includes the count of failures, total count, and error messages per volume.
- **On success**: Optional. Includes total count and combined archive size.

Notifications go through the org's configured notification channels (email, webhook, Slack). See the notification docs for setup.

## Monitoring backup health

To check backup health:

1. View the backup history for each job in **Settings → Backups**.
2. Look at the `lastRunAt` timestamp to confirm jobs are running.
3. Check for jobs with recent `failed` runs.
4. Review per-run logs for error details.

A job that hasn't run when expected may indicate the scheduler is stopped, the Redis lock is stuck, or the server restarted mid-run.

## API

### Targets

```
GET    /api/v1/organizations/{orgId}/backups/targets
POST   /api/v1/organizations/{orgId}/backups/targets
GET    /api/v1/organizations/{orgId}/backups/targets/{targetId}
PUT    /api/v1/organizations/{orgId}/backups/targets/{targetId}
DELETE /api/v1/organizations/{orgId}/backups/targets/{targetId}
```

### Jobs

```
GET    /api/v1/organizations/{orgId}/backups/jobs
POST   /api/v1/organizations/{orgId}/backups/jobs
GET    /api/v1/organizations/{orgId}/backups/jobs/{jobId}
PUT    /api/v1/organizations/{orgId}/backups/jobs/{jobId}
DELETE /api/v1/organizations/{orgId}/backups/jobs/{jobId}
```

### History

```
GET /api/v1/organizations/{orgId}/backups/history
```
