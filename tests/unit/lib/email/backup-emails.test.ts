import { describe, it, expect } from "vitest";
import { backupErrorCause, backupFailureItem } from "@/lib/backups/failure-alert";
import type { BackupResultItem } from "@/lib/backups/run-rules";
import type { BackupSummaryEvent, BusEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { notificationMailBody, renderNotificationEmail } from "@/lib/email/notification-email";
import { subjectLine } from "@/lib/email/subjects";
import { richText, type MailBlock } from "@/lib/email/templates/components";

function fixture<T extends BusEvent["type"]>(name: string): Extract<BusEvent, { type: T }> {
  return EMAIL_FIXTURES.find((f) => f.name === name)!.event as Extract<BusEvent, { type: T }>;
}

function blocks(event: BusEvent): MailBlock[] {
  return notificationMailBody(event, FIXTURE_CONTEXT)!.blocks ?? [];
}

function callouts(event: BusEvent): string[] {
  return blocks(event).flatMap((b) => (b.kind === "callout" ? [richText(b.title)] : []));
}

const failed: BackupResultItem = {
  kind: "backup",
  appId: "app_shop",
  appName: "Shop",
  volumeName: "mysql-data",
  jobName: "Auto: Shop",
  outcome: "failed",
  error: "mysqldump: Got error: 2013: Lost connection to server during query",
  at: "2026-10-09T02:06:00.000Z",
};

describe("backup error cause", () => {
  it("names causes the error states outright", () => {
    expect(backupErrorCause("tar: write error: No space left on device")).toBe("The disk ran out of space while writing the archive.");
    expect(backupErrorCause("pg_dump: error: FATAL: password authentication failed for user \"app\"")).toBe("The database refused the backup's login.");
    expect(backupErrorCause("upload failed: InvalidAccessKeyId")).toBe("The backup target rejected its credentials.");
    expect(backupErrorCause("Error response from daemon: no such volume: shop_data")).toBe("The volume no longer exists.");
    expect(backupErrorCause("Backup timed out after 3600s")).toBe("It timed out before it finished.");
    expect(backupErrorCause(failed.error)).toBe("mysqldump lost its connection to the server mid-dump.");
  });

  it("guesses nothing for an error it doesn't recognize", () => {
    expect(backupErrorCause("tar: ./cache: file changed as we read it")).toBeNull();
    expect(backupErrorCause(undefined)).toBeNull();
  });
});

describe("one backup failed", () => {
  it("reassures with the last good backup, explains the cause and links the app", async () => {
    const event: BusEvent = { type: "alert.fired", title: "", message: "", alerts: [backupFailureItem(failed, { lastGoodAt: "2026-10-08T02:04:00.000Z" })] };
    const email = (await renderNotificationEmail(event, FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ✗ Backup of Shop / mysql-data failed");
    expect(email.text).toContain("Your data is safe. The last good backup, from Oct 8 at 02:04 UTC, is still there.");
    expect(email.text).toContain("✗ mysqldump lost its connection to the server mid-dump\nmysqldump: Got error: 2013");
    expect(email.text).toContain("App: Shop\nJob: Automatic\nFailed: Oct 9, 02:06 UTC");
    expect(email.text).toContain("Open Shop's backups: https://vardo.example.com/apps/app_shop/backups");
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_shop"');
  });

  it("says so when there's no earlier backup and shows the raw error it can't explain", () => {
    const item = backupFailureItem({ ...failed, error: "tar: ./x: file changed as we read it\ntar: exiting" }, { lastGoodAt: null });
    expect(item.view?.reassure).toBeUndefined();
    expect(item.view?.lead).toEqual(["There's no earlier backup of this volume."]);
    expect(item.view?.callout).toEqual({ title: "tar: ./x: file changed as we read it" });
  });

  it("claims nothing when the last good backup is unknown", () => {
    const item = backupFailureItem(failed);
    expect(item.view?.reassure).toBeUndefined();
    expect(item.view?.lead).toEqual([]);
  });
});

describe("backup run summary", () => {
  it("keeps an all-good run short", () => {
    const event = fixture<"backup.summary">("backup-summary");
    const kinds = blocks(event).map((b) => b.kind);
    expect(kinds).toEqual(["text", "tiles", "stats"]);
    expect(callouts(event)).toEqual([]);
    const body = notificationMailBody(event, FIXTURE_CONTEXT)!;
    expect(body.tone).toBe("success");
    expect(body.preheader).toBe("All 6 volumes backed up between 02:00 and 02:41 UTC.");
  });

  it("leaves out the change column and tile without history", () => {
    const event = fixture<"backup.summary">("backup-summary");
    const bare: BackupSummaryEvent = {
      ...event,
      rows: event.rows.map(({ history: _h, previousSize: _p, ...r }) => r),
      apps: event.apps?.map(({ change: _c, ...a }) => a),
    };
    const out = blocks(bare);
    const stats = out.find((b) => b.kind === "stats");
    expect(stats?.kind === "stats" && stats.columns).toEqual(["App", "Volumes", "Size"]);
    const tiles = out.find((b) => b.kind === "tiles");
    expect(tiles?.kind === "tiles" && tiles.tiles[1].sub).toBeUndefined();
  });

  it("gives each problem one callout, failures first, and counts them in the subject", () => {
    const event = fixture<"backup.summary">("backup-summary-problems");
    expect(callouts(event)).toEqual([
      "Shop / mysql-data failed",
      "Shop Staging / uploads is 95% smaller than usual",
      "8 jobs didn't finish before the timeout",
      "17 volumes haven't backed up in 48 hours",
    ]);
    expect(subjectLine(event)).toBe("✗ Nightly backups · 4 need you");
    expect(blocks(event).some((b) => b.kind === "stats")).toBe(false);
  });

  it("says when the failed volume's last good backup was taken", async () => {
    const email = (await renderNotificationEmail(fixture("backup-summary-problems"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("mysqldump lost its connection to the server mid-dump. Its last good backup, from Oct 8 at 02:04 UTC, is still there.");
  });

  it("links the apps behind unfinished jobs and stale volumes", async () => {
    const email = (await renderNotificationEmail(fixture("backup-summary-problems"), FIXTURE_CONTEXT))!;
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_kuma/backups"');
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_agents"');
  });

  it("shows opted-in config binds as not backed up without counting them", async () => {
    const event = fixture<"backup.summary">("backup-summary-config");
    expect(event.succeeded).toBe(6);
    expect(event.skipped).toBe(1);
    const email = (await renderNotificationEmail(event, FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ✓ Backup of Shop and Search · 6 done · 9.8 GiB");
    expect(email.text).toContain("Not backed up — app config the engine leaves out: Search / meili-config.toml.");
    expect(email.text).toContain("Skipped as usual: Mailpit / mailpit-data.");
    expect(email.text).not.toContain("Mailpit: Volumes");
    expect(notificationMailBody(event, FIXTURE_CONTEXT)!.tone).toBe("success");
  });

  it("says which volumes aren't backed up and why, without a warning", async () => {
    const event = fixture<"backup.summary">("backup-summary-not-backed-up");
    const email = (await renderNotificationEmail(event, FIXTURE_CONTEXT))!;
    expect(email.subject).toMatch(/^node-a · ✓ Nightly backups/);
    expect(notificationMailBody(event, FIXTURE_CONTEXT)!.tone).toBe("success");
    expect(email.text).toContain("4 volumes aren't backed up.");
    expect(email.text).toContain("Rebuildable — reconstructed rather than restored: Shop / cache.");
    expect(email.text).toContain("Backups are off for the app: Mailpit / mailpit-data and Mailpit / mailpit-uploads.");
    expect(email.text).toContain("Bind mount, not opted in: Observability / etc-dashboards.");
    expect(email.text).not.toContain("Skipped as usual: Observability / etc-dashboards");
  });

  it("never says slot", async () => {
    for (const f of EMAIL_FIXTURES.filter((f) => f.name.startsWith("backup-"))) {
      const email = (await renderNotificationEmail(f.event, FIXTURE_CONTEXT))!;
      expect(email.text.toLowerCase()).not.toContain("slot");
    }
  });
});
