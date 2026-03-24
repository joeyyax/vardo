# Set Up Automatic Backups

This tutorial walks through configuring automated backups using Cloudflare R2 (or any S3-compatible storage like AWS S3, Backblaze B2, or MinIO).

## Prerequisites

- A running Vardo instance
- An account with an S3-compatible storage provider (Cloudflare R2, AWS S3, Backblaze B2, etc.)

---

## Step 1: Create an R2 Bucket

These steps use Cloudflare R2. The process is similar for other providers.

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. Go to **R2 Object Storage**
3. Click **Create bucket**
4. Name it something like `vardo-backups`
5. Choose a location (pick the region closest to your server)
6. Click **Create bucket**

For AWS S3, create a bucket via the S3 console. For Backblaze B2, create a private bucket in the B2 dashboard.

---

## Step 2: Get Access Credentials

### Cloudflare R2

1. In the R2 dashboard, click **Manage R2 API tokens**
2. Click **Create API token**
3. Give it a name (e.g., `vardo-backups`)
4. Set permissions: **Object Read & Write**
5. Scope it to your specific bucket
6. Click **Create API Token**
7. Copy the **Access Key ID** and **Secret Access Key** — you won't see the secret again

Also note your **Account ID** (visible in the R2 overview sidebar) — you'll need it for the endpoint URL:

```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

### AWS S3

Create an IAM user with `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` permissions on your bucket. Use the IAM user's access key and secret.

Endpoint: `https://s3.<region>.amazonaws.com`

### Backblaze B2

Generate an application key in the B2 dashboard with access to your bucket. Use the `keyID` as the access key and `applicationKey` as the secret.

Endpoint: `https://s3.<region>.backblazeb2.com`

---

## Step 3: Add a Backup Target in Vardo

1. Go to **Backups** in the sidebar
2. Click **New Target**
3. Fill in the form:

   | Field | Value |
   |-------|-------|
   | Name | `Cloudflare R2` (or any label) |
   | Type | `S3` |
   | Endpoint | `https://<account_id>.r2.cloudflarestorage.com` |
   | Bucket | `vardo-backups` |
   | Access Key ID | (from Step 2) |
   | Secret Access Key | (from Step 2) |
   | Path prefix | `backups/` (optional — organizes files within the bucket) |

4. Click **Save**
5. Vardo will test the connection — if it fails, double-check the endpoint URL and credentials

---

## Step 4: Create a Backup Job with a Schedule

1. Click **New Job**
2. Configure the job:

   | Field | Value |
   |-------|-------|
   | Name | `Daily database backup` |
   | Target | Select the target you just created |
   | What to back up | Select the app(s) or choose "All apps" |
   | Schedule | `0 2 * * *` (2am daily) |

3. Set a retention policy (see [Retention Policies](#retention-policies) below)
4. Click **Save**

The job is now active. It will run on schedule and upload backups to your storage target.

---

## Step 5: Verify the First Backup Runs

You don't need to wait for the schedule — trigger a manual run immediately:

1. Find your job in the **Backup Jobs** list
2. Click **Run Now**
3. Watch the status change from **Running** to **Success**
4. Click on the job to see the backup history, file size, and duration

Check your R2 bucket (or S3 console) to confirm the backup file appeared.

---

## Step 6: Test a Restore

Verify your backups are restorable before you need them:

1. Go to the backup job's history
2. Find a completed backup
3. Click **Restore**
4. Select the target app and confirm

The restore process:
1. Downloads the backup from storage
2. Stops the app container
3. Restores the data
4. Restarts the container

**Tip:** Test restores to a staging environment first so you're not restoring over production.

---

## Retention Policies

Retention controls how many backups Vardo keeps. Older backups are deleted automatically after the job runs.

| Tier | Default | Recommended for... |
|------|---------|-------------------|
| **Hourly** | Keep last 24 | High-traffic apps needing fine-grained recovery |
| **Daily** | Keep last 7 | Standard apps |
| **Weekly** | Keep last 4 | Long-term coverage |
| **Monthly** | Keep last 3 | Compliance, audit trails |

Configure these under the job's **Retention** section. More aggressive retention costs more storage; dial it based on your recovery objectives.

---

## Monitoring Backup Health

Vardo shows backup status on the backups page. To catch failures proactively:

- Enable **Notifications** under **Settings → Notifications** — Vardo will alert you when a backup job fails
- Check the **Backup History** table on the backups page — each row shows status, size, and duration
- A job that consistently takes longer than expected may indicate growth in your data or a slow network path to storage

---

## Next Steps

- [Deploy your first app](./deploy-nextjs.md) if you haven't already
- Configure monitoring under **Metrics** to track resource usage over time
- Set up email notifications so you're alerted on backup failures: **Settings → Notifications**
