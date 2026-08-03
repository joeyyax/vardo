import { describe, it, expect } from "vitest";
import type { LabeledSeries, SeriesByMetric, ResourceMetricName } from "@/lib/metrics/resource-samples";
import { appResourceScope, projectResourceScope } from "@/lib/metrics/resource-scope";
import { buildSnapshot, NO_LIMITS, type AppLimits } from "@/lib/metrics/resources";

const NOW = 1_700_000_000_000;
const HOST = { cpuCores: 32, memoryBytes: 64 * 1024 ** 3 };

type Spec = {
  project: string;
  service?: string | null;
  container: string;
  metric: ResourceMetricName;
  points: [number, number][];
};

function seriesFrom(specs: Spec[]): SeriesByMetric {
  const out = new Map<ResourceMetricName, LabeledSeries[]>();
  for (const spec of specs) {
    const entry: LabeledSeries = {
      key: `metrics:${spec.project}:${spec.metric}:${spec.container}`,
      project: spec.project,
      service: spec.service ?? null,
      container: spec.container,
      points: spec.points,
    };
    const list = out.get(spec.metric);
    if (list) list.push(entry);
    else out.set(spec.metric, [entry]);
  }
  return out;
}

// A stack matching how the live host stores metrics: every container in
// `paperless` carries vardo.project=paperless and is told apart by the compose
// service label. `ntfy` is a standalone app in the same Vardo project.
const PARENT = { id: "app-paperless", name: "paperless", parentAppId: null, composeService: null, parentApp: null };
const CHILD_DB = {
  id: "app-paperless-db",
  name: "paperless-paperless-db",
  parentAppId: "app-paperless",
  composeService: "paperless-db",
  parentApp: { name: "paperless" },
};
const CHILD_WEB = {
  id: "app-paperless-web",
  name: "paperless-webserver",
  parentAppId: "app-paperless",
  composeService: "webserver",
  parentApp: { name: "paperless" },
};
const NTFY = { id: "app-ntfy", name: "ntfy", parentAppId: null, composeService: null, parentApp: null };

const KNOWN = new Set(["paperless", "ntfy"]);

// docker stats for the same four containers, so the project total is checkable.
const CPU = { db: 5, web: 30, gotenberg: 1.5, ntfy: 0.25 };
const MEM = { db: 100 * 1024 ** 2, web: 900 * 1024 ** 2, gotenberg: 40 * 1024 ** 2, ntfy: 12 * 1024 ** 2 };

const STACK: Spec[] = [
  { project: "paperless", service: "paperless-db", container: "c-db", metric: "cpu", points: [[NOW - 30_000, CPU.db], [NOW, CPU.db]] },
  { project: "paperless", service: "webserver", container: "c-web", metric: "cpu", points: [[NOW - 30_000, CPU.web], [NOW, CPU.web]] },
  { project: "paperless", service: "gotenberg", container: "c-got", metric: "cpu", points: [[NOW - 30_000, CPU.gotenberg], [NOW, CPU.gotenberg]] },
  { project: "ntfy", service: null, container: "c-ntfy", metric: "cpu", points: [[NOW - 30_000, CPU.ntfy], [NOW, CPU.ntfy]] },

  { project: "paperless", service: "paperless-db", container: "c-db", metric: "memory", points: [[NOW, MEM.db]] },
  { project: "paperless", service: "webserver", container: "c-web", metric: "memory", points: [[NOW, MEM.web]] },
  { project: "paperless", service: "gotenberg", container: "c-got", metric: "memory", points: [[NOW, MEM.gotenberg]] },
  { project: "ntfy", service: null, container: "c-ntfy", metric: "memory", points: [[NOW, MEM.ntfy]] },
];

function snapshotFor(
  app: typeof PARENT | typeof CHILD_DB,
  specs: Spec[] = STACK,
  limits: AppLimits = NO_LIMITS,
) {
  return buildSnapshot({
    subject: { type: "app", id: app.id, name: app.name },
    scope: appResourceScope(app, KNOWN),
    series: seriesFrom(specs),
    limits: [limits],
    host: HOST,
    diskSupported: !app.parentAppId,
    now: NOW,
  });
}

function projectSnapshot(specs: Spec[] = STACK, limits: AppLimits[] = [NO_LIMITS, NO_LIMITS]) {
  return buildSnapshot({
    subject: { type: "project", id: "proj-1", name: "documents" },
    // Every app record in the project, children included — the caller is
    // expected to be able to pass this without producing a double count.
    scope: projectResourceScope([PARENT, CHILD_DB, CHILD_WEB, NTFY], KNOWN),
    series: seriesFrom(specs),
    limits,
    host: HOST,
    diskSupported: true,
    now: NOW,
  });
}

describe("app scope", () => {
  it("gives a compose parent every service in its stack", () => {
    const snap = snapshotFor(PARENT);

    expect(snap.cpu.usage).toBe(CPU.db + CPU.web + CPU.gotenberg);
    expect(snap.containerCount).toBe(3);
  });

  it("gives a compose child only its own container, not the parent's", () => {
    const snap = snapshotFor(CHILD_DB);

    expect(snap.cpu.usage).toBe(CPU.db);
    expect(snap.memory.usage).toBe(MEM.db);
    expect(snap.containerCount).toBe(1);
  });

  it("does not leak another app's containers into a scope", () => {
    expect(snapshotFor(PARENT).cpu.usage).not.toBe(CPU.db + CPU.web + CPU.gotenberg + CPU.ntfy);
  });

  it("reads a shared service stored under its slot compose project", () => {
    const withShared: Spec[] = [
      ...STACK,
      { project: "paperless-production-blue", service: null, container: "c-shared", metric: "cpu", points: [[NOW, 2]] },
    ];

    expect(snapshotFor(PARENT, withShared).cpu.usage).toBe(CPU.db + CPU.web + CPU.gotenberg + 2);
  });

  it("does not fold one app's series into another app of the same name stem", () => {
    const decoy: Spec[] = [
      ...STACK,
      // A real top-level app in its own right, not paperless's shared project.
      { project: "ntfy", service: null, container: "c-ntfy-2", metric: "cpu", points: [[NOW, 7]] },
    ];

    expect(snapshotFor(PARENT, decoy).cpu.usage).toBe(CPU.db + CPU.web + CPU.gotenberg);
  });
});

describe("project totals", () => {
  it("counts every container once even when children are passed in", () => {
    const snap = projectSnapshot();

    expect(snap.cpu.usage).toBe(CPU.db + CPU.web + CPU.gotenberg + CPU.ntfy);
    expect(snap.memory.usage).toBe(MEM.db + MEM.web + MEM.gotenberg + MEM.ntfy);
    expect(snap.containerCount).toBe(4);
  });

  it("matches the sum of its apps' own snapshots", () => {
    const parent = snapshotFor(PARENT);
    const ntfy = buildSnapshot({
      subject: { type: "app", id: NTFY.id, name: NTFY.name },
      scope: appResourceScope(NTFY, KNOWN),
      series: seriesFrom(STACK),
      limits: [NO_LIMITS],
      host: HOST,
      diskSupported: true,
      now: NOW,
    });

    expect(projectSnapshot().cpu.usage).toBe((parent.cpu.usage ?? 0) + (ntfy.cpu.usage ?? 0));
  });

  it("does not double count a container reported under two project labels", () => {
    const rotated: Spec[] = [
      ...STACK,
      // The same container seen under the slot project name as well.
      { project: "paperless-production-blue", service: "webserver", container: "c-web", metric: "cpu", points: [[NOW, CPU.web]] },
    ];

    expect(projectSnapshot(rotated).cpu.usage).toBe(CPU.db + CPU.web + CPU.gotenberg + CPU.ntfy);
  });
});

describe("limits", () => {
  const withLimitSeries = (limits: [string, string | null, number][]): Spec[] =>
    limits.map(([container, service, value]) => ({
      project: "paperless",
      service,
      container,
      metric: "memoryLimit" as ResourceMetricName,
      points: [[NOW, value]] as [number, number][],
    }));

  it("reports enforced when every container in scope is capped", () => {
    const specs = [...STACK, ...withLimitSeries([["c-db", "paperless-db", 1024 ** 3], ["c-web", "webserver", 1024 ** 3], ["c-got", "gotenberg", 1024 ** 3]])];
    const snap = snapshotFor(PARENT, specs);

    expect(snap.memory.limitKind).toBe("enforced");
    expect(snap.memory.limit).toBe(3 * 1024 ** 3);
  });

  it("reports partial when only some containers are capped", () => {
    const specs = [...STACK, ...withLimitSeries([["c-db", "paperless-db", 1024 ** 3], ["c-web", "webserver", 0], ["c-got", "gotenberg", 0]])];
    const snap = snapshotFor(PARENT, specs);

    expect(snap.memory.limitKind).toBe("partial");
    expect(snap.memory.limit).toBe(1024 ** 3);
  });

  it("falls back to host RAM as capacity when nothing is capped", () => {
    const specs = [...STACK, ...withLimitSeries([["c-db", "paperless-db", 0], ["c-web", "webserver", 0], ["c-got", "gotenberg", 0]])];
    const snap = snapshotFor(PARENT, specs);

    expect(snap.memory.limitKind).toBe("capacity");
    expect(snap.memory.limit).toBe(HOST.memoryBytes);
  });

  it("prefers the enforced limit over the number the app record asks for", () => {
    const specs = [...STACK, ...withLimitSeries([["c-db", "paperless-db", 268_435_456]])];
    const snap = snapshotFor(CHILD_DB, specs, { ...NO_LIMITS, memoryLimitMb: 8192 });

    expect(snap.memory.limit).toBe(268_435_456);
    expect(snap.memory.limitKind).toBe("enforced");
  });

  it("converts a CPU limit in cores to the percent scale usage is on", () => {
    const snap = snapshotFor(CHILD_DB, STACK, { ...NO_LIMITS, cpuLimit: 2 });

    expect(snap.cpu.limit).toBe(200);
    expect(snap.cpu.limitKind).toBe("enforced");
    expect(snap.cpu.percent).toBe(2.5);
  });

  it("uses host cores as capacity when no CPU quota is set", () => {
    const snap = snapshotFor(PARENT);

    expect(snap.cpu.limitKind).toBe("capacity");
    expect(snap.cpu.limit).toBe(3200);
  });

  it("states that network has no limit rather than inventing one", () => {
    const snap = snapshotFor(PARENT);

    expect(snap.network.limitKind).toBe("none");
    expect(snap.network.limit).toBeNull();
    expect(snap.network.percent).toBeNull();
  });
});

describe("absent metrics", () => {
  it("reports disk as unsupported for a compose child instead of 0 B", () => {
    const snap = snapshotFor(CHILD_DB);

    expect(snap.disk.usage).toBeNull();
    expect(snap.disk.absence).toBe("unsupported");
    expect(snap.disk.percent).toBeNull();
  });

  it("reports GPU as not collected for an app that never asked for one", () => {
    const snap = snapshotFor(PARENT);

    expect(snap.gpu.usage).toBeNull();
    expect(snap.gpu.absence).toBe("not-collected");
    expect(snap.extras.gpuMemory.usage).toBeNull();
  });

  it("reports GPU as stale, not absent, for a GPU app with no fresh sample", () => {
    const snap = snapshotFor(PARENT, STACK, { ...NO_LIMITS, gpuEnabled: true });

    expect(snap.gpu.absence).toBe("stale");
  });

  it("reports a series that stopped reporting as stale, not zero", () => {
    const old: Spec[] = [
      { project: "paperless", service: "paperless-db", container: "c-db", metric: "cpu", points: [[NOW - 3_600_000, 5]] },
    ];
    const snap = snapshotFor(PARENT, old);

    expect(snap.cpu.usage).toBeNull();
    expect(snap.cpu.absence).toBe("stale");
  });

  it("reports disk writes as not collected when cAdvisor stores nothing", () => {
    const snap = snapshotFor(PARENT);

    expect(snap.extras.diskWrite.usage).toBeNull();
    expect(snap.extras.diskWrite.absence).toBe("not-collected");
  });

  it("keeps a genuinely idle container at zero rather than absent", () => {
    const idle: Spec[] = [
      { project: "ntfy", service: null, container: "c-ntfy", metric: "cpu", points: [[NOW, 0]] },
      { project: "ntfy", service: null, container: "c-ntfy", metric: "memory", points: [[NOW, 0]] },
    ];
    const snap = buildSnapshot({
      subject: { type: "app", id: NTFY.id, name: NTFY.name },
      scope: appResourceScope(NTFY, KNOWN),
      series: seriesFrom(idle),
      limits: [NO_LIMITS],
      host: HOST,
      diskSupported: true,
      now: NOW,
    });

    expect(snap.cpu.usage).toBe(0);
    expect(snap.cpu.absence).toBeNull();
  });
});

describe("network rates", () => {
  const counters: Spec[] = [
    { project: "ntfy", service: null, container: "c-ntfy", metric: "networkRx", points: [[NOW - 10_000, 1000], [NOW, 3000]] },
    { project: "ntfy", service: null, container: "c-ntfy", metric: "networkTx", points: [[NOW - 10_000, 500], [NOW, 1500]] },
  ];

  const snap = () =>
    buildSnapshot({
      subject: { type: "app", id: NTFY.id, name: NTFY.name },
      scope: appResourceScope(NTFY, KNOWN),
      series: seriesFrom(counters),
      limits: [NO_LIMITS],
      host: HOST,
      diskSupported: true,
      now: NOW,
    });

  it("derives bytes per second from the cumulative counters", () => {
    expect(snap().extras.networkRx.usage).toBe(200);
    expect(snap().extras.networkTx.usage).toBe(100);
    expect(snap().network.usage).toBe(300);
  });

  it("ignores a counter that reset rather than reporting a lifetime as a spike", () => {
    const reset: Spec[] = [
      { project: "ntfy", service: null, container: "c-ntfy", metric: "networkRx", points: [[NOW - 10_000, 9_000_000], [NOW, 1000]] },
    ];
    const restarted = buildSnapshot({
      subject: { type: "app", id: NTFY.id, name: NTFY.name },
      scope: appResourceScope(NTFY, KNOWN),
      series: seriesFrom(reset),
      limits: [NO_LIMITS],
      host: HOST,
      diskSupported: true,
      now: NOW,
    });

    expect(restarted.extras.networkRx.usage).toBeNull();
  });
});

describe("sparklines", () => {
  it("sums each bucket across the containers in scope", () => {
    expect(snapshotFor(PARENT).cpu.series).toEqual([
      [NOW - 30_000, CPU.db + CPU.web + CPU.gotenberg],
      [NOW, CPU.db + CPU.web + CPU.gotenberg],
    ]);
  });

  it("is empty rather than a flat zero line when nothing is collected", () => {
    expect(snapshotFor(PARENT).gpu.series).toEqual([]);
  });
});
