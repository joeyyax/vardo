import { describe, it, expect } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail, notificationMailBody } from "@/lib/email/notification-email";
import { notificationSubject } from "@/lib/email/subjects";
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
  it("leads with the state and ends with the commit", () => {
    expect(subject(fixture("deploy-success"))).toBe("✓ acme-2026 deployed · a1b2c3d");
  });

  it("names the failing phase", () => {
    expect(subject(fixture("deploy-failed-build"))).toBe("✗ Shop Staging failed at build");
    expect(subject(fixture("deploy-failed"))).toBe("✗ search-data failed at health check");
  });

  it("names the host for disk alerts", () => {
    expect(subject(fixture("system-disk-alert"))).toBe("⚠ Disk 91% on node-a");
  });

  it("formats bytes for humans", () => {
    expect(subject(fixture("disk-write-alert"))).toBe("⚠ MySQL wrote 7.7 GiB in 1h");
    expect(subject(fixture("backup-success"))).toBe("✓ Backup Nightly · 2.3 GiB");
  });

  it("never says Unknown when the display name is missing", () => {
    const event = { ...fixture<"deploy.failed">("deploy-failed"), projectName: "" };
    expect(subject(event)).toBe("✗ search-data failed at health check");
    const bare = { ...event, appName: undefined, project: undefined };
    expect(subject(bare)).not.toMatch(/unknown/i);
  });

  it("covers the lifecycle", () => {
    expect(subject(fixture("system-started"))).toBe("✓ Vardo back on node-a after 2 min 29 s");
    expect(subject(fixture("system-updated"))).toBe("✓ Vardo updated on node-a · e36c2e3 → 4f1a9b2");
    expect(subject(fixture("system-update-failed"))).toBe("✗ Vardo update failed on node-a at Health check");
  });
});

describe("notification emails", () => {
  it.each(EMAIL_FIXTURES.map((f) => [f.name, f.event] as const))("%s renders HTML and a matching text part", async (_name, event) => {
    const email = await renderNotificationEmail(event, FIXTURE_CONTEXT);
    expect(email).not.toBeNull();
    const body = notificationMailBody(event, FIXTURE_CONTEXT)!;
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
    expect(email.text).toContain("Commit: a1b2c3d Fix donation form validation on mobile <https://github.com/joeyyax/acme-2026/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678>");
    expect(email.text).toContain("Phases: clone 3 s · build 1 min 2 s");
    expect(email.text).toContain("Slot: blue → green");
    expect(email.html).toContain('href="https://acme.org"');
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
