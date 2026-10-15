import { describe, it, expect } from "vitest";
import type { AlertFiredEvent, AlertItem, AlertResolvedEvent, BusEvent, VolumeDriftEvent } from "@/lib/bus/events";
import { memoryUser } from "@/lib/alerts/host";
import { anomalyItem, type Finding } from "@/lib/anomaly/items";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail } from "@/lib/email/notification-email";
import { subjectLine } from "@/lib/email/subjects";
import { alertFiredMail, alertResolvedMail, linkNames } from "@/lib/email/templates/alerts";
import type { MailBlock } from "@/lib/email/templates/components";
import { volumeDriftMail } from "@/lib/email/templates/volume-drift";

function fixture<T extends BusEvent["type"]>(name: string): Extract<BusEvent, { type: T }> {
  const found = EMAIL_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found.event as Extract<BusEvent, { type: T }>;
}

function block<K extends MailBlock["kind"]>(blocks: MailBlock[] | undefined, kind: K): Extract<MailBlock, { kind: K }> | undefined {
  return blocks?.find((b) => b.kind === kind) as Extract<MailBlock, { kind: K }> | undefined;
}

const url = (path: string) => `${FIXTURE_CONTEXT.baseUrl}${path}`;

describe("alert subjects", () => {
  it("keep their icons", () => {
    expect(subjectLine(fixture("alert-host-memory"))).toBe("⚠ Memory 91% used");
    expect(subjectLine(fixture("alert-app-anomaly"))).toBe("✗ Shop is sending far more traffic than usual");
    expect(subjectLine(fixture("volume-drift"))).toBe("⚠ Shop Staging volumes drifted · 14 files");
  });
});

describe("linkNames", () => {
  it("links the first whole-word mention of each name", () => {
    expect(linkNames("Shop and Shopify use Shop", [{ text: "Shop", href: "/s" }])).toEqual([{ text: "Shop", href: "/s" }, " and Shopify use Shop"]);
  });

  it("prefers the longer name where two overlap", () => {
    expect(linkNames("Search Data is up", [{ text: "Search", href: "/a" }, { text: "Search Data", href: "/b" }])).toEqual([
      { text: "Search Data", href: "/b" },
      " is up",
    ]);
  });

  it("leaves text with no names as a string", () => {
    expect(linkNames("Memory 91% used", [{ text: "Shop", href: "/s" }])).toBe("Memory 91% used");
  });
});

describe("host memory email", () => {
  it("lists apps, linked, with memory and limit instead of container names", async () => {
    const mail = alertFiredMail(fixture("alert-host-memory"), FIXTURE_CONTEXT);
    const stats = block(mail.blocks, "stats")!;
    expect(stats.columns).toEqual(["Using the most", "Memory", "Limit"]);
    expect(stats.rows.map((r) => [r.name, r.href, r.sub])).toEqual([
      ["Shop", url("/apps/app_shop"), "wordpress"],
      ["Search Data", url("/apps/app_srch"), "meilisearch"],
      ["Vardo", undefined, "postgres"],
    ]);
    const email = (await renderNotificationEmail(fixture("alert-host-memory"), FIXTURE_CONTEXT))!;
    expect(email.html).not.toContain("shop-production-blue-wordpress-1");
    expect(email.text).not.toContain("Top containers");
  });

  it("maps a container to its app, or to Vardo for its own services", () => {
    const names = new Map([["a1", "Shop"]]);
    const base = { memoryUsage: 1, memoryLimit: 0 };
    expect(memoryUser({ ...base, containerName: "/shop-blue-web-1", labels: { "vardo.project.id": "a1", "com.docker.compose.service": "web" } }, names)).toMatchObject({
      label: "Shop",
      appId: "a1",
      service: "web",
      container: "shop-blue-web-1",
    });
    expect(memoryUser({ ...base, containerName: "/vardo-postgres", labels: {} }, names)).toMatchObject({ label: "Vardo", service: "postgres" });
    expect(memoryUser({ ...base, containerName: "/stray", labels: { "vardo.project.id": "gone" } }, names)).toEqual({ container: "stray", bytes: 1, limit: 0 });
  });
});

describe("host disk email", () => {
  it("shows Docker's own numbers and links the cleanup page", () => {
    const mail = alertFiredMail(fixture("alert-host-disk"), FIXTURE_CONTEXT);
    const stats = block(mail.blocks, "stats")!;
    expect(stats.rows.map((r) => [r.name, ...r.cells.map((c) => (typeof c === "string" ? c : c.value))])).toEqual([
      ["Images", "96 GiB", "31 GiB"],
      ["Build cache", "42 GiB", "9.6 GiB"],
      ["Volumes", "27 GiB", "3 GiB"],
    ]);
    expect(mail.action).toEqual({ label: "Free up space", href: url("/admin/settings/maintenance") });
    expect(mail.links).toEqual([{ label: "Metrics", href: url("/metrics") }]);
  });

  it("leaves the table out when Docker's usage is unknown", () => {
    const event = fixture<"alert.fired">("alert-host-disk");
    const [item] = event.alerts;
    const bare: AlertItem = { ...item, view: { ...item.view, table: undefined } };
    expect(block(alertFiredMail({ ...event, alerts: [bare] }, FIXTURE_CONTEXT).blocks, "stats")).toBeUndefined();
  });
});

describe("several alerts at once", () => {
  it("leads with host memory when it sits alongside kills it caused", () => {
    const mail = alertFiredMail(fixture("alert-coalesced"), FIXTURE_CONTEXT);
    expect(block(mail.blocks, "text")?.text).toBe("They started together at 14:01 UTC. The host ran out of memory, which likely caused the other two.");
    const callouts = mail.blocks!.filter((b) => b.kind === "callout");
    expect(callouts.map((c) => [c.tone, c.action?.label])).toEqual([
      ["bad", "Set a limit"],
      ["bad", "Open metrics"],
      ["warn", "Open Search Data"],
    ]);
    expect(callouts[0].title).toEqual([{ text: "Shop", href: url("/apps/app_shop") }, " is down"]);
  });

  it("names no shared cause the alerts don't carry", () => {
    const event = fixture<"alert.fired">("alert-coalesced");
    const noMemory: AlertFiredEvent = { ...event, alerts: event.alerts.filter((a) => a.type !== "host.memory") };
    expect(block(alertFiredMail(noMemory, FIXTURE_CONTEXT).blocks, "text")?.text).toBe("They started together at 14:02 UTC.");
    const apart: AlertFiredEvent = { ...noMemory, alerts: [noMemory.alerts[0], { ...noMemory.alerts[1], since: "2026-10-09T18:00:00.000Z" }] };
    expect(block(alertFiredMail(apart, FIXTURE_CONTEXT).blocks, "text")?.text).toBe("They fired in the same check.");
  });

  it("doesn't claim they started together when a start is only the first reading after a restart", () => {
    const event = fixture<"alert.fired">("alert-coalesced");
    const [a, b] = event.alerts.filter((x) => x.type !== "host.memory");
    const booted: AlertFiredEvent = { ...event, alerts: [{ ...a, sinceAtLeast: true }, b] };
    expect(block(alertFiredMail(booted, FIXTURE_CONTEXT).blocks, "text")?.text).toBe("They've been going since at least 14:02 UTC.");
  });
});

describe("unusual traffic email", () => {
  const since = Date.parse("2026-10-09T14:02:00.000Z");
  const finding: Finding = {
    signal: "egress",
    verdict: { fires: true, holds: true, severity: "critical", value: 400, since, line: { typical: 10, high: 20, threshold: 60, clearBelow: 30 } },
    recent: [10, 12, 9, 300, 400],
  };
  const top = [{ pid: 1, name: "kworkerd", cpu: 187, rssKb: 1 }, { pid: 2, name: "node", cpu: 3, rssKb: 1 }];

  it("flags a process as new only when the anomaly data says so", () => {
    expect(anomalyItem({ id: "a1", name: "Shop" }, [finding], top, ["kworkerd"]).view?.table?.rows[0].why).toBe("Not seen in this app before");
    expect(anomalyItem({ id: "a1", name: "Shop" }, [finding], top).view?.table?.rows.every((r) => !r.why)).toBe(true);
  });

  it("draws readings over the alert line in red against the usual level", () => {
    const item = anomalyItem({ id: "a1", name: "Shop" }, [finding], top);
    expect(item.view?.heading).toBe("Shop is sending 40× its usual traffic");
    const event: AlertFiredEvent = { type: "alert.fired", title: item.title, message: item.title, alerts: [item] };
    const columns = block(alertFiredMail(event, FIXTURE_CONTEXT).blocks, "columns")!;
    expect(columns.columns.map((c) => c.parts[0].tone)).toEqual([2, 2, 2, "fail", "fail"]);
  });

  it("leaves the process table out without a probe", () => {
    expect(anomalyItem({ id: "a1", name: "Shop" }, [finding], null).view?.table).toBeUndefined();
  });
});

describe("resolved email", () => {
  it("is a table of what cleared and how long it lasted", () => {
    const mail = alertResolvedMail(fixture<"alert.resolved">("alert-resolved"), FIXTURE_CONTEXT);
    expect(mail.heading).toBe("2 alerts resolved");
    expect(block(mail.blocks, "text")?.text).toBe("Both are back under their alert lines.");
    expect(block(mail.blocks, "stats")?.rows).toEqual([
      { name: "Memory 91% used", sub: undefined, href: undefined, cells: ["14:05 UTC", "36 min"] },
      { name: "Shop", sub: "near its memory limit", href: url("/apps/app_shop"), cells: ["13:50 UTC", "51 min"] },
    ]);
    expect(mail.action).toBeUndefined();
  });

  it("marks a start that's only the first reading held", () => {
    const event = fixture<"alert.resolved">("alert-resolved");
    const mail = alertResolvedMail({ ...event, alerts: [{ ...event.alerts[1], sinceAtLeast: true }] }, FIXTURE_CONTEXT);
    expect(block(mail.blocks, "stats")?.rows[0].cells).toEqual(["by 13:50 UTC", "at least 51 min"]);
  });

  it("doesn't speak of alert lines for alerts without one", () => {
    const event: AlertResolvedEvent = {
      type: "alert.resolved",
      title: "",
      message: "",
      alerts: [{ type: "cron.failure", about: "j", severity: "warning", title: "sync failed", detail: "", firedAt: "2026-10-09T14:00:00Z", resolvedAt: "2026-10-09T14:10:00Z" }],
    };
    expect(block(alertResolvedMail(event, FIXTURE_CONTEXT).blocks, "text")?.text).toBe("It cleared.");
  });
});

describe("volume drift email", () => {
  it("counts per volume and marks missing files", () => {
    const mail = volumeDriftMail(fixture<"volume.drift">("volume-drift"), FIXTURE_CONTEXT);
    expect(mail.heading).toBe("14 files in Shop Staging's volumes changed");
    const stats = block(mail.blocks, "stats")!;
    expect(stats.rows[1].cells).toEqual(["0", "0", { value: "2", hot: true }]);
  });

  it("reads right for one file", () => {
    const one: VolumeDriftEvent = { ...fixture<"volume.drift">("volume-drift"), totalDrift: 1, volumes: [{ name: "uploads", modified: 1, added: 0, missing: 0 }] };
    const mail = volumeDriftMail(one, FIXTURE_CONTEXT);
    expect(mail.heading).toBe("1 file in Shop Staging's volumes changed");
    expect(block(mail.blocks, "text")?.text).toMatch(/^It no longer matches the image, and a redeploy won't reset it\./);
  });
});
