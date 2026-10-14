import { describe, it, expect } from "vitest";
import type { AppRecap, DigestAppRecapEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT, RECAP_FIXTURES } from "@/lib/email/fixtures";
import { renderNotificationEmail } from "@/lib/email/notification-email";
import { gigabytes, recapIssues, size } from "@/lib/email/templates/app-recap";

const event = (recaps: AppRecap[]): DigestAppRecapEvent => ({ type: "digest.app-recap", title: "Recaps", message: "", orgName: "Example Home", recaps });
const render = async (recaps: AppRecap[]) => (await renderNotificationEmail(event(recaps), FIXTURE_CONTEXT))!;
const MB = 1024 ** 2;

describe("recap issues", () => {
  it("flags nothing for a healthy app", () => {
    expect(recapIssues(RECAP_FIXTURES.clean, FIXTURE_CONTEXT)).toEqual([]);
  });

  it("puts an unprotected volume first, then memory near the limit", () => {
    expect(recapIssues(RECAP_FIXTURES.actions, FIXTURE_CONTEXT).map((i) => i.title)).toEqual(["immich-library isn't backed up", "Memory peaked near the limit"]);
  });

  it("flags failed deploys at 72 hours and leaves them to the tile at 30 days", () => {
    const failed = { ...RECAP_FIXTURES.clean, deploys: { total: 5, failed: 2 } };
    expect(recapIssues(failed, FIXTURE_CONTEXT).map((i) => i.title)).toEqual(["2 deploys failed"]);
    expect(recapIssues({ ...failed, kind: "30d" }, FIXTURE_CONTEXT)).toEqual([]);
  });

  it("never suggests lowering a limit, however little the app uses", async () => {
    const idle: AppRecap = {
      ...RECAP_FIXTURES.month,
      memory: { avg: 20 * MB, peak: 30 * MB, peakAt: RECAP_FIXTURES.clean.deployedAt, limit: 4096 * MB, daysNearLimit: 0 },
      cpu: { avg: 0.1, peak: 1 },
      imageUpdates: 0,
    };
    expect(recapIssues(idle, FIXTURE_CONTEXT)).toEqual([]);
    for (const recaps of [[idle], [{ ...idle, kind: "72h" as const }], RECAP_FIXTURES.group, [RECAP_FIXTURES.actions]]) {
      const email = await render(recaps);
      expect(`${email.subject}\n${email.text}`).not.toMatch(/\b(lower|reduce|decrease|shrink|cut)\b/i);
    }
  });

  it("only raises memory once usage comes within 10% of the limit", () => {
    const at = (peakMb: number): AppRecap => ({ ...RECAP_FIXTURES.clean, memory: { avg: 100 * MB, peak: peakMb * MB, peakAt: RECAP_FIXTURES.clean.deployedAt, limit: 512 * MB } });
    expect(recapIssues(at(460), FIXTURE_CONTEXT)).toEqual([]);
    expect(recapIssues(at(462), FIXTURE_CONTEXT).map((i) => i.action.label)).toEqual(["Adjust the limit"]);
  });
});

describe("recap emails", () => {
  it("renders every recap fixture", async () => {
    for (const f of EMAIL_FIXTURES.filter((x) => x.name.startsWith("recap-"))) {
      const email = await renderNotificationEmail(f.event, FIXTURE_CONTEXT);
      expect(email?.html).toContain("recap");
    }
  });

  it("titles a healthy 72-hour recap after the app and points to the next one", async () => {
    const email = await render([RECAP_FIXTURES.clean]);
    expect(email.subject).toBe("node-a · 72-hour recap: mowp-2026");
    expect(email.text).toContain("Vardo has a baseline for how mowp-2026 normally runs.");
    expect(email.text).toContain("Next recap in 27 days.");
    expect(email.html).toContain("https://vardo.example.com/apps/app_mowp");
  });

  it("names the first issue in the subject", async () => {
    expect((await render([RECAP_FIXTURES.actions])).subject).toBe("node-a · 72-hour recap: immich · library isn't backed up");
    expect((await render([RECAP_FIXTURES.month])).subject).toBe("node-a · 30-day recap: mowp-2026 · memory near the limit");
  });

  it("calls the 30-day recap the last one", async () => {
    const email = await render([RECAP_FIXTURES.month]);
    expect(email.text).toContain("mowp-2026's first month. This is the last recap.");
    expect(email.text).not.toContain("Next recap");
  });

  it("groups same-day recaps into one table with apps that need a person first", async () => {
    const email = await render(RECAP_FIXTURES.group);
    expect(email.subject).toBe("node-a · 72-hour recap: 12 apps · 3 need you");
    const order = ["paperless", "qbittorrent", "gitea", "plex"].map((name) => email.text.indexOf(`${name}:`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(email.text).toContain("paperless-media isn't backed up · Set up");
    expect(email.text).toContain("Memory 1 GB (at limit)");
  });

  it("names both kinds when a day mixes them", async () => {
    const email = await render([RECAP_FIXTURES.clean, { ...RECAP_FIXTURES.actions, kind: "30d" }]);
    expect(email.subject).toBe("node-a · App recaps: 2 apps · 1 need you");
  });
});

describe("recap sizes", () => {
  it("reads like the mockups", () => {
    expect(size(195 * MB)).toBe("195 MB");
    expect(size(0.9 * 1024 * MB)).toBe("0.9 GB");
    expect(size(212 * 1024 * MB)).toBe("212 GB");
    expect(gigabytes(40 * MB)).toBe("<0.1 GB");
    expect(gigabytes(400 * MB)).toBe("0.4 GB");
  });
});
