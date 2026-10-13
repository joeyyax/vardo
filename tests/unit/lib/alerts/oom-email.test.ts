import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", async () => ({ redis: (await import("@/tests/unit/helpers/fake-redis")).createFakeRedis() }));
import {
  OOM_SETTLE_MS,
  oomFacts,
  oomNextStep,
  oomObservation,
  oomWhatHappened,
  recentOomKills,
  recordOomKill,
  resetOomKills,
  type OomFollowup,
  type OomRecord,
} from "@/lib/alerts/oom";
import { alertFiredMail } from "@/lib/email/templates/alerts";
import { notificationSubject } from "@/lib/email/subjects";
import { EMAIL_FIXTURES } from "@/lib/email/fixtures";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const killedAt = Date.parse("2026-10-10T09:46:00Z");
const ctx = { baseUrl: "https://vardo.example.com", instanceName: "example", timeZone: "America/Los_Angeles" };

const after: OomFollowup = {
  status: "running",
  runningSince: new Date("2026-10-10T09:48:00Z"),
  dockerRestarts: 1,
  vardoRestarts: 0,
  gaveUp: false,
  limitBytes: 2 * GIB,
  limitSource: "default",
  peakBytes: 2 * GIB,
  timeZone: "America/Los_Angeles",
};

function record(path: "process" | "exit", kind: "oom-limit" | "oom-host" = "oom-limit"): OomRecord {
  resetOomKills();
  recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "shop-blue-web-1", containerId: "c1", kind, path, restartCount: 4 }, killedAt);
  return recentOomKills(killedAt)[0];
}

beforeEach(() => resetOomKills());

describe("OOM kill path", () => {
  it("keeps whether the container exited or only a process died", () => {
    expect(record("process").path).toBe("process");
    expect(record("exit")).toMatchObject({ path: "exit", restartBaseline: 4, containerIds: new Set(["c1"]) });
  });

  it("counts a later exit over an earlier process kill", () => {
    resetOomKills();
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit", path: "process" }, killedAt);
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit", path: "exit", restartCount: 2 }, killedAt + 1000);
    expect(recentOomKills(killedAt + 1000)[0]).toMatchObject({ path: "exit", kills: 2, restartBaseline: 2 });
  });
});

describe("OOM wording", () => {
  it("says an exited container hit its default limit and came back", () => {
    expect(oomWhatHappened(record("exit"), after)).toBe(
      "It hit its 2 GiB limit (Vardo's default; none set in compose) and exited. Docker restarted it once; it's been running since 02:48 PDT.",
    );
  });

  it("says a process died and the container kept running", () => {
    expect(oomWhatHappened(record("process"), after)).toBe(
      "A process inside it hit its 2 GiB limit (Vardo's default; none set in compose) and was killed; the container kept running.",
    );
  });

  it("names where the limit came from", () => {
    expect(oomWhatHappened(record("exit"), { ...after, limitSource: "compose" })).toContain("2 GiB limit (set in compose)");
    expect(oomWhatHappened(record("exit"), { ...after, limitSource: "app" })).toContain("2 GiB limit (set in Vardo)");
  });

  it("says when it's still down and Vardo stopped restarting it", () => {
    const down = { ...after, status: "down" as const, runningSince: null, dockerRestarts: 0, vardoRestarts: 3, gaveUp: true };
    expect(oomWhatHappened(record("exit"), down)).toBe(
      "It hit its 2 GiB limit (Vardo's default; none set in compose) and exited. Vardo restarted it 3 times and stopped; it's still down.",
    );
  });

  it("blames the host for a host kill", () => {
    expect(oomWhatHappened(record("exit", "oom-host"), { ...after, limitBytes: 0, limitSource: "none" })).toMatch(
      /^The host ran out of memory and the kernel killed it; it has no limit of its own\. Docker restarted it once/,
    );
    expect(oomWhatHappened(record("process", "oom-host"), after)).toBe(
      "The host ran out of memory and the kernel killed a process inside it; the container kept running.",
    );
  });
});

describe("OOM next step", () => {
  it("suggests peak × 1.5, sized from at least the limit for a limit kill", () => {
    expect(oomNextStep(record("exit"), after, null)).toBe("Raise the limit to 3 GiB.");
    expect(oomNextStep(record("exit"), { ...after, peakBytes: 1 * GIB }, null)).toBe("Raise the limit to 3 GiB.");
    expect(oomNextStep(record("exit"), { ...after, limitBytes: 4 * GIB, peakBytes: 5 * GIB }, null)).toBe("Raise the limit to 7.5 GiB.");
  });

  it("offers a limit for an uncapped app the host killed", () => {
    const uncapped = { ...after, limitBytes: 0, limitSource: "none" as const, peakBytes: 3 * GIB };
    expect(oomNextStep(record("exit", "oom-host"), uncapped, null)).toBe("Free memory on the host, or give it a limit of 4.5 GiB.");
  });

  it("says what the Auto profile did", () => {
    expect(oomNextStep(record("exit"), after, { kind: "raised", toMb: 3072, live: true })).toBe(
      "Vardo raised the limit to 3 GiB (the memory profile is Auto). It applies now.",
    );
    expect(oomNextStep(record("exit"), after, { kind: "held", reason: "host-tight" })).toBe(
      "The memory profile is Auto, but the host is short on memory, so Vardo didn't raise the limit. Raise the limit to 3 GiB.",
    );
    expect(oomNextStep(record("exit"), after, { kind: "halted", raises: 3 })).toMatch(/^The Auto profile raised the limit 3 times without it settling and has stopped\./);
  });
});

describe("OOM facts", () => {
  it("lists limit, peak, restarts and status", () => {
    expect(oomFacts(record("exit"), after)).toEqual([
      { label: "Limit", value: "2 GiB (Vardo's default; none set in compose)" },
      { label: "Peak (1h)", value: "2 GiB" },
      { label: "Restarts", value: "1" },
      { label: "Status", value: "Running since 02:48 PDT" },
    ]);
  });

  it("reads missing data plainly", () => {
    const facts = oomFacts(record("exit"), { ...after, status: "down", runningSince: null, peakBytes: null, dockerRestarts: null, limitBytes: 0, limitSource: "none" });
    expect(facts).toEqual([
      { label: "Limit", value: "None" },
      { label: "Peak (1h)", value: "No data" },
      { label: "Restarts", value: "0" },
      { label: "Status", value: "Down" },
    ]);
  });
});

describe("OOM alert", () => {
  it("waits for an exited container to settle before it fires", () => {
    const r = record("exit");
    expect(oomObservation(r, null, killedAt + 1000).fires).toBe(false);
    expect(oomObservation(r, after, killedAt + OOM_SETTLE_MS).fires).toBe(true);
    expect(oomObservation(record("process"), after, killedAt).fires).toBe(true);
  });

  it("titles by what happened next", () => {
    expect(oomObservation(record("exit"), after, killedAt + OOM_SETTLE_MS).item.title).toBe("Shop killed for memory · running again");
    expect(oomObservation(record("exit"), { ...after, status: "down" }, killedAt + OOM_SETTLE_MS).item.title).toBe("Shop killed for memory · still down");
    expect(oomObservation(record("process"), after, killedAt).item.title).toBe("Shop killed for memory · still running");
  });

  it("renders as an email with the subject, status first and each fact once", () => {
    const r = record("exit");
    const { item } = oomObservation(r, after, killedAt + OOM_SETTLE_MS);
    const event = { type: "alert.fired" as const, title: item.title, message: item.title, alerts: [item] };
    expect(notificationSubject(event, ctx)).toMatch(/✗ Shop killed for memory · running again$/);

    const mail = alertFiredMail(event, ctx);
    expect(mail.heading).toBe("Shop was killed for memory");
    expect(mail.blocks?.[0]).toEqual({ kind: "reassure", strong: "It's running again.", text: "Docker restarted it at 02:48 PDT." });
    expect(mail.blocks?.[1]).toEqual({ kind: "text", text: "It hit its 2 GiB limit, Vardo's default since compose doesn't set one. Raise the limit to 3 GiB." });
    const tiles = mail.blocks?.find((b) => b.kind === "tiles");
    expect(tiles && "tiles" in tiles ? tiles.tiles.map((t) => t.label) : []).toEqual(["Peak", "Limit", "Restarts"]);
    expect(mail.facts).toBeUndefined();
    expect(mail.action).toEqual({ label: "Change the limit", href: "https://vardo.example.com/apps/a1/resources" });
  });

  it("says what the Auto profile did in place of advice", () => {
    const r = record("exit");
    r.autotune = { kind: "raised", toMb: 3072, live: true };
    const view = oomObservation(r, after, killedAt + OOM_SETTLE_MS).item.view!;
    expect(view.lead).toEqual(["It hit its 2 GiB limit, Vardo's default since compose doesn't set one. Its memory profile is Auto, so Vardo raised the limit to 3 GiB, starting now."]);
    expect(view.tiles?.find((t) => t.label === "New limit")).toEqual({ label: "New limit", value: "3", unit: " GiB", sub: "was 2 GiB" });
  });

  it("matches the email fixture", () => {
    const r = record("exit");
    r.autotune = { kind: "raised", toMb: 3072, live: true };
    const pdt = { ...after, runningSince: new Date("2026-10-09T14:04:00Z") };
    const fixture = EMAIL_FIXTURES.find((f) => f.name === "alert-oom")!.event as { alerts: { view?: unknown }[] };
    expect(oomObservation(r, pdt, killedAt + OOM_SETTLE_MS).item.view).toEqual({ ...(fixture.alerts[0].view as object), action: { label: "Change the limit", path: "/apps/a1/resources" } });
  });

  it("leads with down and a limit to set for an uncapped app the host killed", () => {
    resetOomKills();
    for (const at of [killedAt, killedAt + 1000]) {
      recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-host", path: "exit", restartCount: 0 }, at);
    }
    const r = recentOomKills(killedAt + 1000)[0];
    const down = { ...after, status: "down" as const, runningSince: null, dockerRestarts: 0, vardoRestarts: 3, gaveUp: true, limitBytes: 0, limitSource: "none" as const, peakBytes: GIB };
    const { item } = oomObservation(r, down, killedAt + OOM_SETTLE_MS);
    expect(item.hostMemory).toBe(true);
    expect(item.view?.reassure).toBeUndefined();
    expect(item.view?.brief).toEqual({
      title: "Shop is down",
      body: "Killed twice with no limit of its own. Vardo restarted it 3 times, then stopped. Free memory on the host, or give it a limit of 1.5 GiB.",
    });
    expect(item.view?.action).toEqual({ label: "Set a limit", path: "/apps/a1/resources" });
    expect(item.view?.tiles?.find((t) => t.label === "Restarts")).toMatchObject({ value: "3", sub: "restarts stopped", hot: true });
  });

  it("says the container kept running when only a process died", () => {
    const view = oomObservation(record("process", "oom-host"), after, killedAt).item.view!;
    expect(view.heading).toBe("A process in Shop was killed for memory");
    expect(view.brief).toEqual({ title: "Shop lost a process", body: "The kernel killed one process inside it. The container kept running." });
    expect(view.tiles?.map((t) => t.label)).not.toContain("Restarts");
    expect(view.action).toEqual({ label: "Open Shop", path: "/apps/a1" });
  });
});
