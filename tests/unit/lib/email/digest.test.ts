import { describe, it, expect } from "vitest";
import type { DigestHealthEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail } from "@/lib/email/notification-email";
import { digestCallouts, digestMail } from "@/lib/email/templates/digest";

const fixture = (name: string) => EMAIL_FIXTURES.find((f) => f.name === name)!.event as DigestHealthEvent;
const monthly = fixture("digest-monthly");
const watching = fixture("digest-watching");
const ctx = { ...FIXTURE_CONTEXT, timeZone: "America/Los_Angeles" };

describe("digest email", () => {
  it("names the month and counts what needs a person", async () => {
    const email = (await renderNotificationEmail(monthly, ctx))!;
    expect(email.subject).toBe("node-a · October in Example Home · 3 need you");
    expect(email.text).toContain("391 deploys across 44 apps. Backups ran 98% of the time and all 12 alerts resolved.");
  });

  it("opens with callouts, actions first, and never suggests lowering a limit", async () => {
    const titles = digestCallouts(monthly, ctx).map((c) => (typeof c.title === "string" ? c.title : c.title.map((p) => (typeof p === "string" ? p : "text" in p ? p.text : "")).join("")));
    expect(titles).toEqual(["14 volumes without a backup in 48 hours", "2 restore drills failed", "qbittorrent was killed for memory 10 times"]);
    const email = (await renderNotificationEmail(watching, ctx))!;
    expect(email.text).not.toMatch(/lower|reduce/i);
  });

  it("links names in callouts, facts and tables", async () => {
    const { html } = (await renderNotificationEmail(monthly, ctx))!;
    expect(html).toContain('href="https://vardo.example.com/apps/app_gitea/backups"');
    expect(html).toContain('href="https://vardo.example.com/apps/app_scrypted"');
    expect(html).toContain('href="https://vardo.example.com/projects/proj_wizarr"');
  });

  it("says which apps were started and stopped, and how long a started one was off", async () => {
    const event: DigestHealthEvent = {
      ...monthly,
      lifecycle: [
        { appId: "app_jellyfin", appName: "jellyfin", kind: "stopped", at: "2026-10-15T18:00:00Z", stoppedMs: null },
        { appId: "app_lonvr", appName: "lonvr", kind: "started", at: "2026-10-17T18:00:00Z", stoppedMs: 44 * 86_400_000 },
      ],
    };
    const { text } = (await renderNotificationEmail(event, ctx))!;
    expect(text).toContain("jellyfin: Stopped Oct 15");
    expect(text).toContain("lonvr: Started Oct 17 after 44 days stopped");
  });

  it("lists a stopped app's backups as on hold with the last backup in the org's zone, not as a callout", async () => {
    const event: DigestHealthEvent = {
      ...monthly,
      stoppedBackups: [
        { appId: "app_lonvr", appName: "Reeve NVR", lastBackupAt: "2026-08-02T05:00:00Z" },
        { appId: "app_restream", appName: "Restream", lastBackupAt: null },
      ],
    };
    const { text, html } = (await renderNotificationEmail(event, ctx))!;
    expect(text).toContain("Reeve NVR: App stopped · last backup Aug 1");
    expect(text).toContain("Restream: App stopped · never backed up");
    expect(html).toContain('href="https://vardo.example.com/apps/app_lonvr/backups"');
    expect(digestCallouts(event, ctx)).toHaveLength(digestCallouts(monthly, ctx).length);
  });

  it("shows new apps and what deploys changed", async () => {
    const { text } = (await renderNotificationEmail(monthly, ctx))!;
    expect(text).toContain("scrypted: Deployed Oct 11 · 30-day recap on Nov 10");
    expect(text).toContain("ntfy: Now listening on tcp/8443 since Oct 19");
    expect(text).toContain("formbricks: Now runs worker since Oct 22");
    expect(text).toContain("and 18 more projects with no deploys or issues");
  });

  it("says how often it comes and how to change it", () => {
    expect(digestMail(monthly, ctx).footer).toMatchObject({ note: "Sent monthly.", settingsLabel: "Switch to weekly or turn off" });
    expect(digestMail(fixture("digest-weekly"), ctx).footer).toMatchObject({ note: "Sent weekly.", settingsLabel: "Switch to monthly or turn off" });
  });

  it("adds each watched project with its sites, uptime and response time", async () => {
    const { text } = (await renderNotificationEmail(watching, ctx))!;
    expect(text).toContain("Watching MOWP");
    expect(text).toContain("9 min down across 3 sites. 103 deploys, 6 failed.");
    expect(text).toContain("Response time: 182 ms (median · p95 410 ms)");
    expect(text).toMatch(/mowp-2026 \(www\.example\.org\).*\n {2}Memory near the limit · Adjust limit/);
    expect(text).toContain("Sent monthly. You're watching MOWP.");
    expect(text).toContain("Stop watching: https://vardo.example.com/user/settings/notifications");
  });

  it("leaves watched sections out when nothing is watched", async () => {
    const { text } = (await renderNotificationEmail(monthly, ctx))!;
    expect(text).not.toContain("Watching");
    expect(text).not.toContain("Stop watching");
  });

  it("titles a weekly digest by its first day", async () => {
    const email = (await renderNotificationEmail(fixture("digest-weekly"), ctx))!;
    expect(email.subject).toBe("node-a · Week of Oct 5 in Acme Studio · 2 need you");
  });
});
