import { describe, it, expect, vi } from "vitest";
import type { BusEvent } from "@/lib/bus/events";

vi.mock("@/lib/system-settings", () => ({ getEmailProviderConfig: async () => null, getInstanceDisplayName: async () => "node-a" }));

import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail, notificationMailBody } from "@/lib/email/notification-email";
import { fromDisplayName } from "@/lib/email/send";
import { capPreheader, PREHEADER_MAX } from "@/lib/email/templates/components";
import { splitCommand } from "@/lib/email/templates/deploy-incomplete";
import { phaseVisual } from "@/lib/email/templates/deploy-facts";
import { formatDurationRough, versionShort } from "@/lib/email/format";

function fixture<T extends BusEvent["type"]>(name: string): Extract<BusEvent, { type: T }> {
  return EMAIL_FIXTURES.find((f) => f.name === name)!.event as Extract<BusEvent, { type: T }>;
}

describe("one instance name", () => {
  it("builds the From name from the instance when none is set", () => {
    expect(fromDisplayName(undefined, "prod-1")).toBe("prod-1 · Vardo");
    expect(fromDisplayName("", "prod-1")).toBe("prod-1 · Vardo");
    expect(fromDisplayName("Vardo", "prod-1")).toBe("prod-1 · Vardo");
    expect(fromDisplayName("Ops Team", "prod-1")).toBe("Ops Team");
    expect(fromDisplayName(undefined, null)).toBe("Vardo");
    expect(fromDisplayName(undefined, "Vardo")).toBe("Vardo");
  });

  it("leads the header with the instance and mutes Vardo", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-success"), FIXTURE_CONTEXT))!;
    expect(email.html).toMatch(/node-a<span[^>]*> · Vardo<\/span>/);
  });

  it("signs the footer with the instance and the console host", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-success"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("Sent by Vardo on node-a (vardo.example.com).");
    expect(email.html).toContain("Sent by Vardo on node-a (vardo.example.com).");
  });
});

describe("preheader", () => {
  it("renders one title, the heading, and keeps the preheader out of it", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-success"), FIXTURE_CONTEXT))!;
    expect(email.html.match(/<title>/g)).toHaveLength(1);
    expect(email.html).toContain("<title>acme-web is live</title>");
  });

  it("caps at about 90 characters, cut at a word", () => {
    const long = "Pre-build for blue failed: the build ran out of memory and was stopped before it could affect the host";
    const capped = capPreheader(long);
    expect(capped.length).toBeLessThanOrEqual(PREHEADER_MAX);
    expect(capped.endsWith("…")).toBe(true);
    expect(long.startsWith(capped.slice(0, -1))).toBe(true);
    expect(capped).not.toMatch(/\s…$/);
    expect(capPreheader("short line")).toBe("short line");
  });
});

describe("deploy emails", () => {
  it("folds a leading cd into the command block", () => {
    const reason =
      "shared service app-db still runs its old definition — apply it with: cd /opt/vardo/apps/app/production/blue && docker compose -f docker-compose.yml -p app-production-shared up -d --no-deps app-db";
    const { text, command } = splitCommand(reason);
    expect(command).toBe("cd /opt/vardo/apps/app/production/blue && docker compose -f docker-compose.yml -p app-production-shared up -d --no-deps app-db");
    expect(text).toBe("shared service app-db still runs its old definition — apply it with: the command below");
  });

  it("shows one duration on a success", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-success"), FIXTURE_CONTEXT))!;
    expect(email.text).not.toContain("timed");
    expect(email.text).toMatch(/Duration: /);
  });

  it("marks the phase that failed, even one that never reported a time", () => {
    const timings = { clone: { ms: 1_000 } } as Parameters<typeof phaseVisual>[0];
    const visual = phaseVisual(timings, "build", { totalMs: 2_000 })!;
    if (visual.kind !== "stacked") throw new Error("stacked");
    expect(visual.segments.map((s) => [s.label, s.tone])).toEqual([
      ["Clone", 0],
      ["Build", "fail"],
    ]);
    expect(visual.segments[1].value).toBe(1_000);
  });

  it("still marks a timed failing phase", () => {
    const timings = { clone: { ms: 1_000 }, build: { ms: 4_000 }, up: { ms: 500 } } as Parameters<typeof phaseVisual>[0];
    const visual = phaseVisual(timings, "build")!;
    if (visual.kind !== "stacked") throw new Error("stacked");
    expect(visual.segments.map((s) => [s.label, s.tone])).toEqual([
      ["Clone", 0],
      ["Build", "fail"],
    ]);
  });
});

describe("cron emails", () => {
  it("links a URL job's URL", () => {
    const body = notificationMailBody(
      { ...fixture<"cron.failed">("cron-failed"), jobType: "url", target: "https://www.example.com/wp-cron.php?doing_wp_cron" },
      FIXTURE_CONTEXT,
    )!;
    expect(body.facts?.find((f) => f.label === "URL")?.href).toBe("https://www.example.com/wp-cron.php?doing_wp_cron");
  });
});

describe("timestamps", () => {
  it("print in the instance's zone", async () => {
    const ctx = { ...FIXTURE_CONTEXT, timeZone: "America/Los_Angeles" };
    const backups = (await renderNotificationEmail(fixture("backup-summary"), ctx))!;
    expect(backups.text).toMatch(/Ran: .*P[DS]T/);
    const unclean = (await renderNotificationEmail(fixture("system-recovered-unclean"), ctx))!;
    expect(unclean.text).toMatch(/Last heartbeat: .*P[DS]T/);
    expect(unclean.text).not.toContain("2026-10-09T16:51:30.000Z");
  });
});

describe("format helpers", () => {
  it("rounds a duration to minutes once it's past one", () => {
    expect(formatDurationRough(267_000)).toBe("4 min");
    expect(formatDurationRough(42_000)).toBe("42 s");
  });

  it("pulls the commit out of a version label", () => {
    expect(versionShort("0.1.0 (bc2083d)")).toBe("bc2083d");
    expect(versionShort("4f1a9b2c3d")).toBe("4f1a9b2");
    expect(versionShort("v0.2.0")).toBe("v0.2.0");
  });
});
