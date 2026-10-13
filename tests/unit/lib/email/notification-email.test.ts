import { describe, it, expect } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail, notificationMailBody } from "@/lib/email/notification-email";
import { notificationSubject, subjectLine } from "@/lib/email/subjects";
import { splitCommand } from "@/lib/email/templates/deploy-incomplete";
import { capLogLines } from "@/lib/email/templates/components";
import { commitUrl, formatDuration, repoWebUrl } from "@/lib/email/format";

function fixture<T extends BusEvent["type"]>(name: string): Extract<BusEvent, { type: T }> {
  const found = EMAIL_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found.event as Extract<BusEvent, { type: T }>;
}

const subject = (event: BusEvent) => notificationSubject(event, FIXTURE_CONTEXT);

describe("notification subjects", () => {
  it("leads with the instance, then the state, and ends with the commit", () => {
    expect(subject(fixture("deploy-success"))).toBe("node-a · ✓ acme-web deployed · a1b2c3d");
    expect(subjectLine(fixture("deploy-success"))).toBe("✓ acme-web deployed · a1b2c3d");
  });

  it("names the failing phase, then the commit for a build or what's still serving", () => {
    expect(subjectLine(fixture("deploy-failed-build"))).toBe("✗ Shop Staging failed at build · 9f8e7d6");
    expect(subjectLine(fixture("deploy-failed"))).toBe("✗ search-data failed at health check · still serving the previous version");
    expect(subjectLine({ ...fixture<"deploy.failed">("deploy-failed"), serving: "none" })).toBe("✗ search-data failed at health check");
  });

  it("never repeats the instance at the end", () => {
    for (const { event } of EMAIL_FIXTURES) expect(subject(event)).not.toMatch(/ on node-a\b/);
    expect(subjectLine(fixture("alert-host-disk"))).toBe("⚠ Disk 91% full");
    expect(subjectLine(fixture("alert-coalesced"))).toBe("✗ Shop killed for memory · still down · 2 more");
    expect(subjectLine(fixture("alert-oom"))).toBe("✗ Shop killed for memory · running again");
    expect(subjectLine(fixture("alert-resolved"))).toBe("✓ 2 alerts resolved");
    expect(subjectLine(fixture("system-service-down"))).toMatch(/^✗ \S+ down$/);
  });

  it("formats bytes for humans", () => {
    expect(subjectLine(fixture("disk-write-alert"))).toBe("⚠ Shop Staging MySQL wrote 7.7 GiB in an hour");
    expect(subjectLine(fixture("backup-summary"))).toBe("✓ Nightly backups · 6 done · 9.8 GiB");
    expect(subjectLine(fixture("backup-summary-failed"))).toBe("✗ Nightly backups · 2 failed");
    expect(subjectLine(fixture("backup-failure"))).toBe("✗ Backup of Shop / mysql-data failed");
  });

  it("never says Unknown when the display name is missing", () => {
    const event = { ...fixture<"deploy.failed">("deploy-failed"), projectName: "" };
    expect(subjectLine(event)).toBe("✗ search-data failed at health check · still serving the previous version");
    const bare = { ...event, appName: undefined, project: undefined };
    expect(subject(bare)).not.toMatch(/unknown/i);
  });

  it("keeps update subjects focused on status", () => {
    expect(subjectLine(fixture("system-started"))).toBe("⚠ Vardo back up after 2 min · 2 apps didn't come back");
    expect(subjectLine(fixture("system-started-console"))).toBe("✓ Vardo back up after 38 s");
    expect(subjectLine(fixture("system-recovered-unclean"))).toBe("⚠ Vardo stopped unexpectedly");
    expect(subjectLine(fixture("system-restart-failed"))).toBe("✗ The shared services didn't come back");
    expect(subjectLine(fixture("system-updated"))).toBe("✓ Vardo updated · 4f1a9b2");
    expect(subjectLine(fixture("system-update-failed"))).toBe("✗ Vardo update failed at health check");
    expect(subjectLine(fixture("system-update-skipped"))).toBe("⚠ Vardo update skipped · v0.2.0");
    expect(subjectLine(fixture("system-update-started"))).toBe("↑ Vardo update started");
  });

  it("says how far behind an update is, never its raw commits", () => {
    expect(subject(fixture("system-update-available-self-deploy"))).toBe("node-a · ↑ Vardo update available · 12 commits");
    expect(subjectLine({ ...fixture<"system.update-available">("system-update-available-self-deploy"), target: "v0.2.0" })).toBe("↑ Vardo update available · v0.2.0");
  });

  it("names every instance of a rollout and leaves the instance prefix off", () => {
    expect(subject(fixture("system-rollout-finished"))).toBe("✓ Vardo updated on jy0 and Long House · 4f1a9b2");
    expect(subject(fixture("system-rollout-finished-skipped"))).toBe("⚠ Vardo updated on 1 of 2 instances · 4f1a9b2");
    expect(subject(fixture("system-rollout-paused"))).toBe("✗ Vardo update paused · 4f1a9b2");
  });

  it("never says slot in a lifecycle or update email", async () => {
    for (const { name, event } of EMAIL_FIXTURES.filter((f) => f.event.type.startsWith("system."))) {
      const email = (await renderNotificationEmail(event, FIXTURE_CONTEXT))!;
      expect(`${email.subject}\n${email.text}`, name).not.toMatch(/\bslots?\b/i);
    }
  });

  it("names the job and app when a cron alert clears", () => {
    const event: BusEvent = {
      type: "alert.resolved",
      title: "Resolved",
      message: "",
      alerts: [
        {
          type: "cron.failure",
          about: "job_1",
          severity: "critical",
          title: "WP Cron is failing on Shop",
          detail: "HTTP 521",
          appId: "app_shop",
          appName: "Shop",
          facts: [{ label: "Job", value: "WP Cron" }, { label: "App", value: "Shop" }],
          since: "2026-10-10T07:10:00.000Z",
          firedAt: "2026-10-10T07:10:00.000Z",
          resolvedAt: "2026-10-10T07:14:27.000Z",
        },
      ],
    };
    expect(subject(event)).toBe("node-a · ✓ WP Cron on Shop recovered after 4 min");
  });

  it("says what a scan found, once per batch", () => {
    expect(subjectLine(fixture("security-scan-batch"))).toBe("✗ 3 new security findings on 2 apps");
    expect(subjectLine(fixture("security-scan-manual-clean"))).toBe("✓ Security scan · Acme Docs · no issues");
  });

  it("links Update now in the update email on a self-deploy instance, and the host command otherwise", () => {
    const self = notificationMailBody(fixture("system-update-available-self-deploy"), FIXTURE_CONTEXT)!;
    expect(self.action).toEqual({ label: "Update now", href: "https://vardo.example.com/admin/settings/maintenance?update=now#updates" });
    expect(self.blocks?.some((b) => b.kind === "log")).toBe(false);
    const legacy = notificationMailBody({ ...fixture<"system.update-available">("system-update-available-self-deploy"), selfDeploy: false }, FIXTURE_CONTEXT)!;
    expect(legacy.blocks).toContainEqual({ kind: "log", lines: ["sudo vardo update"], highlight: [] });
  });
});

describe("notification emails", () => {
  it.each(EMAIL_FIXTURES.map((f) => [f.name, f.event, f.series] as const))("%s renders HTML and a matching text part", async (_name, event, series) => {
    const ctx = { ...FIXTURE_CONTEXT, series };
    const email = await renderNotificationEmail(event, ctx);
    expect(email).not.toBeNull();
    const body = notificationMailBody(event, ctx)!;
    expect(email!.html).not.toMatch(/<svg|<script|display:\s*(flex|grid)|background-image/i);
    expect(email!.html).toContain(body.heading.replace(/'/g, "&#x27;"));
    expect(email!.text).toContain(body.heading);
    expect(email!.html).toContain("prefers-color-scheme:dark");
    expect(email!.text).toContain("Notification settings: https://vardo.example.com/user/settings/notifications");
    expect(email!.html).not.toContain("?tab=");
    expect(email!.text).not.toMatch(/\bunknown\b/i);
    for (const fact of body.facts ?? []) expect(email!.text).toContain(fact.value);
  });

  it("puts the commit, phases and links in a success email", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-success"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("a1b2c3d Fix donation form validation on mobile, by Alex Kim, is live on acme.example.org.");
    expect(email.html).toContain('href="https://github.com/acme/acme-web/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"');
    expect(email.text).toContain("Where the time went\nClone 3 s · Build 1 min 2 s · Pull 4 s · Start 6 s · Health 12 s · Cleanup 2 s");
    expect(email.text).toContain("Took: 1 min 32 s (usual 1 min 40 s)");
    expect(email.text).toContain("Rollback: The previous version is kept ready");
    expect(email.html).toContain('href="https://vardo.example.com/projects/prj_acme"');
    expect(email.html).toContain('href="https://acme.example.org"');
    expect(email.text).toContain("Deployment log: https://vardo.example.com/apps/app_9xk2/deployments");
  });

  it("says what's serving, the cause once and the crash loop's last cycle in a failure email", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-failed"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Nothing is down. The previous version is still serving.");
    expect(email.text).toContain("meilisearch crashed on start\nIt restarted 5 times before Vardo gave up.");
    expect(email.text.split("is incompatible with your current engine").length - 1).toBe(1);
    expect(email.text).toContain("Last log lines\n    meilisearch-1  | 2026-10-09T17:02:19Z");
    expect(email.text).not.toContain("See logs above");
  });

  it("caps the log block", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const capped = capLogLines(lines);
    expect(capped).toHaveLength(20);
    expect(capped.at(-1)).toBe("line 49");
    expect(capLogLines(["x".repeat(500)])[0].length).toBeLessThanOrEqual(240);
  });

  it("disk write alerts explain database writes differently", async () => {
    const db = (await renderNotificationEmail(fixture("disk-write-alert"), FIXTURE_CONTEXT))!;
    expect(db.text).toContain("Shop Staging's MySQL wrote 7.7 GiB in an hour");
    expect(db.text).toContain("Its threshold is 4 GiB. From a database this usually means a bulk import");
    expect(db.text).not.toContain("S3/R2");
    expect(db.text).not.toContain("shop-staging-data-production-blue-shop-staging-mysql-1");
    expect(db.text.match(/4 GiB/g)).toHaveLength(1);
    const app = (await renderNotificationEmail({ ...fixture<"disk.write-alert">("disk-write-alert"), dataEngine: false }, FIXTURE_CONTEXT))!;
    expect(app.text).toContain("S3/R2");
  });

  it("leads a failed cron with the cause, then recent runs and the output", async () => {
    const email = (await renderNotificationEmail(fixture("cron-failed"), FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ✗ Cron sync-orders failed on Shop Staging");
    expect(email.text).toContain("✗ PHP ran out of memory\nIt hit PHP's 128 MB limit in wpdb. Raise memory_limit for WP-CLI or trim what the event loads.");
    expect(email.text).toContain("Last 24 runs\n✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✗ 23 succeeded, 1 failed");
    expect(email.text).toContain("  > PHP Fatal error:");
    expect(email.text).toContain("Schedule: Every 15 minutes · last success Oct 9, 16:45 UTC");
    expect(email.text).not.toContain("Container:");
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_shop_staging"');
  });

  it("falls back to the exit code when the output names no cause", async () => {
    const email = (await renderNotificationEmail(fixture("cron-failed-exit"), FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ✗ Cron failure test failed on Shop Docs");
    expect(email.text).toContain("✗ The command exited with code 3");
    expect(email.text).toContain("Command: echo testing failure path; exit 3");
    expect(email.text).toContain("Schedule: Every minute · no success on record");
    expect(email.text).toContain("Output\n    testing failure path");
    expect(email.text).not.toContain("Last 24 runs");
    expect(email.text).toContain("Open the cron job: https://vardo.example.com/apps/app_d0cs/cron");
  });

  it("sends no email for a backup run starting", async () => {
    const event: BusEvent = {
      type: "backup.run-started",
      title: "Nightly backups starting",
      message: "",
      runId: "run_1",
      kind: "nightly",
      label: "Nightly backups",
      apps: [],
      volumeCount: 0,
      estimatedMs: null,
      target: null,
    };
    expect(await renderNotificationEmail(event, FIXTURE_CONTEXT)).toBeNull();
  });

  it("lists only the problem rows when a quiet run emails, with a link to the full run", async () => {
    const email = (await renderNotificationEmail(fixture("backup-summary-problems"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Shop Staging / uploads is 95% smaller than usual");
    expect(email.text).not.toContain("Acme Data:");
    expect(email.text).toContain("View the full run: https://vardo.example.com/backups");
  });

  it("lists each app's new findings as callouts linked to its security tab", async () => {
    const email = (await renderNotificationEmail(fixture("security-scan-batch"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Shop · shop.example.com\n✗ .env is publicly accessible\nThe file at /.env is served");
    expect(email.text).toContain("⚠ TLS certificate expires in 9 days\nRenewal hasn't succeeded yet.\nView the finding: https://vardo.example.com/apps/app_d0cs/security");
    expect(email.text).toContain("From the scheduled scan of 14 apps.");
    expect(email.text.indexOf(".env is publicly")).toBeLessThan(email.text.indexOf("Missing HSTS"));
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_shop"');
    expect(email.html).toContain("vd-callout-bad");
    expect(email.html).toContain("vd-callout-warn");
  });

  it("shows what a clean scan checked and links the domain", async () => {
    const email = (await renderNotificationEmail(fixture("security-scan-manual-clean"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Nothing turned up on docs.example.com.");
    expect(email.text).toContain("exposed files, headers, TLS, open ports");
    expect(email.html).toContain('href="https://docs.example.com"');
  });

  it("leads a certificate email with days left and links the app it belongs to", async () => {
    const email = (await renderNotificationEmail(fixture("system-cert-expiring"), FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ⚠ Certificate expires in 6 d · acme.example.org");
    expect(email.text).toContain("Let's Encrypt renews 30 days ahead");
    expect(email.text).toContain("Expires: 6 days (Oct 15)");
    expect(email.text).toContain("App: acme-web (Acme Nonprofit)");
    expect(email.text).not.toMatch(/Issuer|\ble\b/);
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_acme"');
    expect(email.html).toContain('href="https://www.acme.example.org"');
  });

  it("says an expired certificate is refused and leaves out an app it doesn't know", async () => {
    const email = (await renderNotificationEmail(fixture("system-cert-expired"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Browsers refuse the connection until it renews.");
    expect(email.text).toContain("Expired: 2 days ago (Oct 7)");
    expect(email.text).not.toContain("App:");
  });

  it("says how far behind an available update is, with one button and the change history", async () => {
    const email = (await renderNotificationEmail(fixture("system-update-available-self-deploy"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("4f1a9b2 is 12 commits newer than what node-a runs. Your apps keep running during the update.");
    expect(email.text).not.toContain("fix(email)");
    expect(email.text).not.toContain("Technical details");
    expect(email.text).toContain("Update now: ");
    expect(email.text).toContain("What changed: https://github.com/example/vardo/compare/e36c2e3...4f1a9b2");
  });

  it("puts the new commit, how far it moved and the downtime in an update email", async () => {
    const email = (await renderNotificationEmail(fixture("system-updated"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("node-a is on 4f1a9b2, 12 commits newer. Your apps kept running throughout.");
    expect(email.html).toContain('href="https://github.com/example/vardo/compare/e36c2e3...4f1a9b2"');
    expect(email.text).toContain("Took: 3 min 32 s\nConsole down: 18 s");
    expect(email.text).not.toContain("0.1.0");
    expect(email.text).not.toContain("fix(email)");
  });

  it("reassures only when a failed update rolled back", async () => {
    const rolledBack = (await renderNotificationEmail(fixture("system-update-failed"), FIXTURE_CONTEXT))!;
    expect(rolledBack.text).toContain("Nothing changed. Vardo rolled back and is running e36c2e3.");
    expect(rolledBack.text).toContain("The new console didn't become healthy within 2 minutes\nUpdate to 4f1a9b2 stopped at health check");
    expect(rolledBack.text).toContain("Retry on the host\n    sudo vardo update");
    const stuck = (await renderNotificationEmail({ ...fixture<"system.update-failed">("system-update-failed"), rolledBack: false }, FIXTURE_CONTEXT))!;
    expect(stuck.text).not.toContain("Nothing changed");
  });

  it("lists each failed update check with what it needs", async () => {
    const email = (await renderNotificationEmail(fixture("system-update-skipped"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Jobs: Now 1 deploy in progress · Needs none");
    expect(email.text).toContain("Disk: Now 3.1 GB free, 94% used · Needs 5 GB and under 90%");
    const odd = (await renderNotificationEmail({ ...fixture<"system.update-skipped">("system-update-skipped"), reasons: ["This version failed its health check here and was rolled back"] }, FIXTURE_CONTEXT))!;
    expect(odd.text).toContain("This version failed its health check here and was rolled back");
  });

  it("folds containers that didn't come back into the back-up email, linked to their apps", async () => {
    const email = (await renderNotificationEmail(fixture("system-started"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("The host rebooted. Apps with a restart policy came back on their own, except these two.");
    expect(email.text).toContain("search-data: Container meilisearch · State exited");
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_srch"');
    expect(email.text).toContain("Version 0.1.0 (e36c2e3)");
    const one = { ...fixture<"system.started">("system-started"), containers: [fixture<"system.started">("system-started").containers![0]] };
    expect(notificationMailBody(one, FIXTURE_CONTEXT)!.action).toEqual({ label: "Open search-data", href: "https://vardo.example.com/apps/app_srch" });
    expect(notificationMailBody(fixture("system-started-console"), FIXTURE_CONTEXT)!.action).toBeUndefined();
  });

  it("says when a long unexpected stop went down and how long it lasted", async () => {
    const email = (await renderNotificationEmail(fixture("system-recovered-unclean"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("It went down at 16:51 UTC without shutting down cleanly, like a power loss or a crash, and was back about 21 min later. The host rebooted.");
    expect(email.text).toContain("Open activity: https://vardo.example.com/activity");
  });

  it("names what didn't come back after a shared-services restart", async () => {
    const email = (await renderNotificationEmail(fixture("system-restart-failed"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Your apps are still serving. Vardo itself can't deploy or back up until this is fixed.");
    expect(email.text).toContain("vardo-postgres isn't back\nStill not back 5 min after the restart you started from Maintenance.");
  });

  it("says what stops while a shared service is down", async () => {
    const email = (await renderNotificationEmail(fixture("system-service-down"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Your apps are still serving. Only Vardo itself is affected.");
    expect(email.text).toContain("Deploys, metrics and live logs are paused\nredis holds Vardo's queues and cache. Its last check took 5 s.");
    const traefik = (await renderNotificationEmail({ ...fixture<"system.service-down">("system-service-down"), service: "Traefik" }, FIXTURE_CONTEXT))!;
    expect(traefik.text).not.toContain("still serving");
    const other = (await renderNotificationEmail({ ...fixture<"system.service-down">("system-service-down"), service: "vardo-wg", message: "The watchdog gave up on vardo-wg.", latencyMs: undefined }, FIXTURE_CONTEXT))!;
    expect(other.text).toContain("The watchdog gave up on vardo-wg.");
  });

  it("sends one rollout email naming every instance", async () => {
    const done = (await renderNotificationEmail(fixture("system-rollout-finished"), FIXTURE_CONTEXT))!;
    expect(done.text).toContain("jy0 and Long House are on 4f1a9b2. Your apps kept running throughout.");
    expect(done.text).not.toContain("State");
    const skipped = (await renderNotificationEmail(fixture("system-rollout-finished-skipped"), FIXTURE_CONTEXT))!;
    expect(skipped.text).toContain("jy0 is on 4f1a9b2. Skipped instances stay on their version");
    expect(skipped.text).toContain("Long House: State Skipped\n  Skipped by an admin");
    const paused = (await renderNotificationEmail(fixture("system-rollout-paused"), FIXTURE_CONTEXT))!;
    expect(paused.text).toContain("Long House: State Failed\n  Post-update health check failed; rolled back");
  });

  it("shows rollout priority and status before technical details", async () => {
    const event = {
      type: "system.rollout-started",
      title: "Rollout started",
      message: "",
      rolloutId: "rollout_1",
      targetSha: "f09896b",
      targetLabel: "f09896b",
      members: [
        { instanceId: "lh1", name: "Long House", priority: "standard", state: "waiting", reason: null },
        { instanceId: "jy0", name: "jy0", priority: "critical", state: "waiting", reason: null },
      ],
    } satisfies BusEvent;
    const email = (await renderNotificationEmail(event, FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("Vardo update started for jy0 and Long House");
    expect(email.text).toContain("1. jy0: Waiting · Critical priority\n2. Long House: Waiting · Standard priority");
    expect(email.text).toContain("Up to two can update at once; a busy instance waits until it's ready.");
    expect(email.text.indexOf("View rollout:")).toBeLessThan(email.text.indexOf("Skip priority order:"));
    expect(email.text.indexOf("Technical details")).toBeGreaterThan(email.text.indexOf("Skip priority order:"));
    expect(email.text).not.toContain("Roll out everywhere now");

  });

  it("leaves out a zero console downtime", async () => {
    const email = (await renderNotificationEmail({ ...fixture<"system.updated">("system-updated"), downSeconds: 0 }, FIXTURE_CONTEXT))!;
    expect(email.text).not.toContain("Console down");
  });

  it("counts jobs that timed out as part of the run", async () => {
    const event = fixture<"backup.summary">("backup-summary-timed-out");
    const email = (await renderNotificationEmail(event, FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ⚠ Nightly backups · 2 need you");
    expect(email.text).toContain("10 of 18 volumes backed up before the run timed out at 03:01 UTC.");
    expect(email.text).toContain("Backed up: 10/18 (8 didn't finish)");
    expect(email.text).toContain("Took: 1 h 1 min (then timed out)");
    expect(email.text).toContain("⚠ 8 jobs didn't finish before the timeout\nShop Staging, Search Data,");
    expect(email.text).not.toContain("Auto: ");
  });

  it("links no rollback that only repeats the deployment log", async () => {
    for (const name of ["deploy-success", "deploy-failed"]) {
      const email = (await renderNotificationEmail(fixture(name), FIXTURE_CONTEXT))!;
      expect(email.text).not.toContain("Roll back:");
    }
  });

  it("leaves big growth out of Needs a look and rolls it up per app", async () => {
    const email = (await renderNotificationEmail(fixture("backup-summary-problems"), FIXTURE_CONTEXT))!;
    expect(email.text).not.toContain("loki-data");
    expect(email.text).not.toContain("larger");
    expect(email.text).toContain("smaller than usual");
  });

  it("names a stack child with its stack in a disk write alert", async () => {
    const email = (await renderNotificationEmail(
      { ...fixture<"disk.write-alert">("disk-write-alert"), appName: "Runner", projectName: "Site Audit", dataEngine: false },
      FIXTURE_CONTEXT,
    ))!;
    expect(email.subject).toBe("node-a · ⚠ Site Audit Runner wrote 7.7 GiB in an hour");
    expect(email.text).toContain("Site Audit's Runner wrote 7.7 GiB in an hour");
  });

  it("skips UI-only events", async () => {
    const event: BusEvent = { type: "deploy.status", title: "", message: "", appId: "a", deploymentId: "d", status: "running", success: false };
    expect(await renderNotificationEmail(event, FIXTURE_CONTEXT)).toBeNull();
  });
});

describe("deploy.incomplete command extraction", () => {
  it("pulls the failed command into its own block", () => {
    const { text, command, output } = splitCommand(fixture<"deploy.incomplete">("deploy-incomplete").reason);
    expect(text).toBe("the old slot (blue) is still running");
    expect(command).toMatch(/^docker compose -f .* -p formbricks-production-blue stop$/);
    expect(output).toMatch(/^Error response from daemon/);
  });

  it("leaves plain reasons alone", () => {
    expect(splitCommand("the image prune timed out")).toEqual({ text: "the image prune timed out" });
  });
});

describe("format helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatDuration(7_440_000)).toBe("2 h 4 min");
  });

  it("turns git remotes into browse URLs", () => {
    expect(repoWebUrl("git@github.com:joeyyax/vardo.git")).toBe("https://github.com/joeyyax/vardo");
    expect(repoWebUrl("https://x-access-token:abc@github.com/joeyyax/vardo.git")).toBe("https://github.com/joeyyax/vardo");
    expect(repoWebUrl("/srv/repo")).toBeNull();
    expect(commitUrl("https://gitlab.com/a/b", "abc")).toBe("https://gitlab.com/a/b/-/commit/abc");
  });
});
