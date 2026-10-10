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

  it("names the failing phase", () => {
    expect(subjectLine(fixture("deploy-failed-build"))).toBe("✗ Shop Staging failed at build");
    expect(subjectLine(fixture("deploy-failed"))).toBe("✗ search-data failed at health check");
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
    expect(subjectLine(fixture("disk-write-alert"))).toBe("⚠ Shop Staging MySQL wrote 7.7 GiB in 1h");
    expect(subjectLine(fixture("backup-summary"))).toBe("✓ Nightly backups · 6 done · 9.8 GiB");
    expect(subjectLine(fixture("backup-summary-failed"))).toBe("✗ Nightly backups · 2 failed");
    expect(subjectLine(fixture("backup-summary-grew"))).toBe("⚠ Nightly backups · Observability much larger than last run");
    expect(subjectLine(fixture("backup-failure"))).toBe("✗ Backup of Shop / mysql-data failed");
  });

  it("never says Unknown when the display name is missing", () => {
    const event = { ...fixture<"deploy.failed">("deploy-failed"), projectName: "" };
    expect(subjectLine(event)).toBe("✗ search-data failed at health check");
    const bare = { ...event, appName: undefined, project: undefined };
    expect(subject(bare)).not.toMatch(/unknown/i);
  });

  it("covers the lifecycle with commits, not package versions", () => {
    expect(subjectLine(fixture("system-started"))).toBe("✓ Vardo back after 2 min 29 s");
    expect(subjectLine(fixture("system-updated"))).toBe("✓ Vardo updated · e36c2e3 → 4f1a9b2 fix(email): one instance name in every subject");
    expect(subjectLine(fixture("system-update-failed"))).toBe("✗ Vardo update failed at Health check");
    expect(subjectLine(fixture("system-update-skipped"))).toBe("⚠ Vardo update skipped · v0.2.0");
    expect(subjectLine(fixture("system-update-started"))).toBe("↑ Vardo updating · e36c2e3");
  });

  it("counts an update's commits and names the newest", () => {
    expect(subject(fixture("system-update-available-self-deploy"))).toBe(
      "node-a · ↑ Vardo update · 12 commits · fix(email): one instance name in every subject",
    );
    const long = { ...fixture<"system.update-available">("system-update-available-self-deploy"), commits: [{ sha: "abc1234", subject: "x".repeat(40) + " " + "y".repeat(60) }] };
    expect(subjectLine(long)).toBe(`↑ Vardo update · 12 commits · ${"x".repeat(40)}…`);
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
    expect(self.command).toBeUndefined();
    const legacy = notificationMailBody({ ...fixture<"system.update-available">("system-update-available-self-deploy"), selfDeploy: false }, FIXTURE_CONTEXT)!;
    expect(legacy.command?.text).toBe("sudo vardo update");
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

  it("puts the deploy facts, phases and links in a success email", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-success"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Commit: a1b2c3d Fix donation form validation on mobile <https://github.com/acme/acme-web/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678>");
    expect(email.text).toContain("Phases\nClone 3% · Build 69% · Pull 5% · Start 7% · Health wait 14% · Cleanup 2%");
    expect(email.text).toContain("Slot: blue → green");
    expect(email.html).toContain('href="https://acme.example.org"');
    expect(email.text).toContain("Deployment log: https://vardo.example.com/apps/app_9xk2/deployments");
  });

  it("shows the crash line, the log tail and what's serving in a failure email", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-failed"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Crash: Error: Your database version (1.13.3) is incompatible");
    expect(email.text).toContain("Last log lines\n    meilisearch-1");
    expect(email.text).toContain("The previous release is still serving.");
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
    expect(db.text).toContain("bulk load");
    expect(db.text).not.toContain("S3/R2");
    expect(db.text).toContain("Written: 7.7 GiB in 1h");
    expect(db.text).toContain("Threshold: 4 GiB");
    expect(db.text.split("shop-staging-data-production-blue-shop-staging-mysql-1").length - 1).toBe(1);
    const app = (await renderNotificationEmail({ ...fixture<"disk.write-alert">("disk-write-alert"), dataEngine: false }, FIXTURE_CONTEXT))!;
    expect(app.text).toContain("S3/R2");
  });

  it("gives a failed cron its command, exit code, schedule and units", async () => {
    const email = (await renderNotificationEmail(fixture("cron-failed-exit"), FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ✗ Cron failure test failed on Shop Docs");
    expect(email.text).toContain("Command: echo testing failure path; exit 3");
    expect(email.text).toContain("Exit code: 3");
    expect(email.text).toContain("Schedule: every minute (* * * * *)");
    expect(email.text).toContain("Ran for: 112 ms");
    expect(email.text).toContain("Container: shop-docs-production-green-web-1");
    expect(email.text).toContain("Last success: None on record");
    expect(email.text).toContain("Output\n    testing failure path");
    expect(email.text).toContain("Open run history: https://vardo.example.com/apps/app_d0cs/cron");
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
    expect(email.text).toContain("Observability / loki-data: 532.6 MiB, +31,046% vs last run's 1.7 MiB");
    expect(email.text).not.toContain("By app");
    expect(email.text).not.toContain("Shop: ");
    expect(email.text).toContain("View the full run: https://vardo.example.com/backups");
  });

  it("lists each app's new findings with severity and a link to its security tab", async () => {
    const email = (await renderNotificationEmail(fixture("security-scan-batch"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Shop · shop.example.com\nCritical: .env is publicly accessible. The file at /.env is served");
    expect(email.text).toContain("Warning: TLS certificate expires in 9 days. Renewal hasn't succeeded yet.");
    expect(email.text).toContain("14 apps scanned.");
    expect(email.text).toContain("Open Shop security: https://vardo.example.com/apps/app_shop/security");
    expect(email.text).toContain("Acme Docs security: https://vardo.example.com/apps/app_d0cs/security");
    expect(email.html).toContain('href="https://vardo.example.com/apps/app_d0cs/security"');
  });

  it("shows what's new in an update, with Update now first", async () => {
    const email = (await renderNotificationEmail(fixture("system-update-available-self-deploy"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("What's new\n4f1a9b2: fix(email): one instance name in every subject · Dev Example");
    expect(email.text).toContain("and 9 more commits");
    const updateNow = email.text.indexOf("Update now:");
    const all = email.text.indexOf("View all changes on GitHub: https://github.com/example/vardo/compare/e36c2e3...4f1a9b2");
    expect(updateNow).toBeGreaterThan(-1);
    expect(all).toBeGreaterThan(updateNow);
  });

  it("shows commits, not the package version, when Vardo updated", async () => {
    const email = (await renderNotificationEmail(fixture("system-updated"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Version: e36c2e3 → 4f1a9b2 fix(email): one instance name in every subject");
    expect(email.text).not.toContain("0.1.0");
    expect(email.text).toContain("What's new\n4f1a9b2");
  });

  it("puts big growth up top and rolls the rest up per app", async () => {
    const email = (await renderNotificationEmail(fixture("backup-summary-grew"), FIXTURE_CONTEXT))!;
    const look = email.text.indexOf("Needs a look");
    const byApp = email.text.indexOf("By app");
    expect(look).toBeGreaterThan(-1);
    expect(byApp).toBeGreaterThan(look);
    expect(email.text).toContain("Observability / loki-data: 532.6 MiB, +31,046% vs last run's 1.7 MiB");
    expect(email.text).toContain("Observability / prometheus-data: 71.8 MiB, +241% vs last run's 21.1 MiB");
    expect(email.text).not.toContain("redis-data");
    expect(email.text).toContain("Observability: 617.6 MiB · 4 volumes · +1,639% vs last run");
    expect(email.text).not.toContain("same as last run");
  });

  it("names a stack child with its stack in a disk write alert", async () => {
    const email = (await renderNotificationEmail(
      { ...fixture<"disk.write-alert">("disk-write-alert"), appName: "Runner", projectName: "Site Audit", dataEngine: false },
      FIXTURE_CONTEXT,
    ))!;
    expect(email.subject).toBe("node-a · ⚠ Site Audit Runner wrote 7.7 GiB in 1h");
    expect(email.text).toContain("Site Audit Runner is writing a lot to disk");
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
