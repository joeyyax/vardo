import { describe, it, expect } from "vitest";

import {
  containerTotals,
  coreServiceKey,
  describeCoreTotals,
  isCoreApp,
  resolveMetricsScope,
  scopePhrase,
  shapeCoreServices,
  type CoreContainer,
} from "@/lib/metrics/core-services";
import { groupServerApps, type ServerApp } from "@/lib/metrics/server-groups";

const GB = 1024 ** 3;

function c(id: string, name: string, over: Partial<CoreContainer> = {}): CoreContainer {
  return { containerId: id, containerName: name, composeService: null, cpuPercent: 0, memoryUsage: 0, memoryLimit: 0, ...over };
}

describe("coreServiceKey", () => {
  it.each([
    ["vardo-frontend", null, "console"],
    ["vardo-postgres", null, "database"],
    ["/vardo-redis", null, "cache"],
    ["vardo-traefik", null, "proxy"],
    ["vardo-buildkit", null, "builder"],
    ["vardo-watchdog", null, "watchdog"],
    ["vardo-mesh-builder", "mesh-builder", "mesh"],
    ["collector", null, "metrics"],
    ["loki", null, "logs"],
    ["promtail", null, "logs"],
    ["vardo-wireguard", null, "mesh"],
    ["something-else", null, "other"],
    ["random-name-1", "postgres", "database"],
  ])("%s (%s) is %s", (name, service, key) => {
    expect(coreServiceKey({ containerName: name, composeService: service })).toBe(key);
  });
});

describe("shapeCoreServices", () => {
  it("merges Loki and Promtail into one row and keeps display order", () => {
    const { rows } = shapeCoreServices([
      c("1", "promtail", { cpuPercent: 10, memoryUsage: GB }),
      c("2", "vardo-frontend", { cpuPercent: 20, memoryUsage: 2 * GB, memoryLimit: 4 * GB }),
      c("3", "loki", { cpuPercent: 5, memoryUsage: GB }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["console", "logs"]);
    expect(rows[1]).toMatchObject({ cpu: 15, memory: 2 * GB, containers: 2, label: "Logs (Loki/Promtail)" });
    expect(rows[0].limit).toBe(4 * GB);
  });

  it("counts a container once when apps report it twice", () => {
    const dup = c("1", "vardo-postgres", { cpuPercent: 40, memoryUsage: GB });
    const { rows, totals } = shapeCoreServices([dup, { ...dup }]);
    expect(rows).toHaveLength(1);
    expect(totals).toEqual({ cpu: 40, memory: GB, containers: 1 });
  });

  it("returns no rows without containers", () => {
    expect(shapeCoreServices([])).toEqual({ rows: [], totals: { cpu: 0, memory: 0, containers: 0 } });
  });
});

describe("describeCoreTotals", () => {
  it("states memory and cores", () => {
    expect(describeCoreTotals({ cpu: 30, memory: 1.4 * GB })).toBe("Vardo uses 1.4 GB and 0.30 cores");
  });
});

describe("containerTotals", () => {
  it("sums unique containers", () => {
    expect(containerTotals([c("1", "a", { cpuPercent: 10, memoryUsage: 5 }), c("2", "b", { cpuPercent: 5, memoryUsage: 7 })])).toEqual({
      cpu: 15,
      memory: 12,
      containers: 2,
    });
  });
});

describe("isCoreApp", () => {
  it("matches apps in the Vardo org only", () => {
    expect(isCoreApp({ organizationId: "vardo" }, "vardo")).toBe(true);
    expect(isCoreApp({ organizationId: "acme" }, "vardo")).toBe(false);
    expect(isCoreApp({ organizationId: "acme" }, null)).toBe(false);
  });
});

describe("resolveMetricsScope", () => {
  const base = { orgIds: ["a", "b"], currentOrgId: "a" };

  it("defaults admins to the server and others to the current org", () => {
    expect(resolveMetricsScope({ ...base, param: null, isAdmin: true })).toEqual({ kind: "server" });
    expect(resolveMetricsScope({ ...base, param: undefined, isAdmin: false })).toEqual({ kind: "org", orgId: "a" });
  });

  it("gives the server scope to admins only", () => {
    expect(resolveMetricsScope({ ...base, param: "server", isAdmin: true })).toEqual({ kind: "server" });
    expect(resolveMetricsScope({ ...base, param: "server", isAdmin: false })).toEqual({ kind: "org", orgId: "a" });
  });

  it("honors an organization the viewer belongs to", () => {
    expect(resolveMetricsScope({ ...base, param: "b", isAdmin: false })).toEqual({ kind: "org", orgId: "b" });
    expect(resolveMetricsScope({ ...base, param: "b", isAdmin: true })).toEqual({ kind: "org", orgId: "b" });
  });

  it("ignores an organization the viewer is not in", () => {
    expect(resolveMetricsScope({ ...base, param: "zzz", isAdmin: false })).toEqual({ kind: "org", orgId: "a" });
    expect(resolveMetricsScope({ ...base, param: "zzz", isAdmin: true })).toEqual({ kind: "server" });
  });
});

describe("scopePhrase", () => {
  it("names the server or the organization", () => {
    expect(scopePhrase("server", "Acme")).toBe("on this server");
    expect(scopePhrase("org", "Acme")).toBe("in Acme");
  });
});

function app(id: string, over: Partial<ServerApp>): ServerApp {
  return {
    id,
    name: id,
    displayName: id.toUpperCase(),
    status: "active",
    organizationId: "acme",
    organizationName: "Acme",
    projectId: "p1",
    projectName: "Site",
    containers: [],
    ...over,
  };
}

describe("groupServerApps", () => {
  it("groups by organization then project and sorts by memory", () => {
    const { orgs } = groupServerApps([
      app("web", { containers: [c("1", "web", { cpuPercent: 10, memoryUsage: GB })] }),
      app("db", { containers: [c("2", "db", { cpuPercent: 5, memoryUsage: 3 * GB })] }),
      app("blog", {
        organizationId: "zed",
        organizationName: "Zed",
        projectId: "p9",
        projectName: "Blog",
        containers: [c("3", "blog", { memoryUsage: 100 * GB })],
      }),
    ]);
    expect(orgs.map((o) => o.name)).toEqual(["Zed", "Acme"]);
    const acme = orgs[1];
    expect(acme).toMatchObject({ cpu: 15, memory: 4 * GB, containers: 2 });
    expect(acme.projects[0].apps.map((a) => a.appName)).toEqual(["db", "web"]);
  });

  it("sets core apps apart as service rows", () => {
    const { orgs, core } = groupServerApps([
      app("vardo", {
        organizationId: "vardo",
        organizationName: "Vardo",
        isCore: true,
        containers: [c("1", "vardo-frontend", { memoryUsage: GB }), c("2", "vardo-postgres", { memoryUsage: GB })],
      }),
      app("web", { containers: [c("3", "web", { memoryUsage: GB })] }),
    ]);
    expect(orgs.map((o) => o.id)).toEqual(["acme"]);
    expect(core.rows.map((r) => r.key)).toEqual(["console", "database"]);
    expect(core.totals.containers).toBe(2);
  });

  it("counts compose children under their parent and does not double count", () => {
    const shared = c("1", "vardo-postgres", { memoryUsage: GB });
    const { orgs } = groupServerApps([
      app("stack", { containers: [shared, c("2", "stack-web", { memoryUsage: GB })] }),
      app("stack-db", { parentAppId: "stack", containers: [{ ...shared }] }),
    ]);
    expect(orgs[0].containers).toBe(2);
    expect(orgs[0].projects[0].apps).toHaveLength(1);
  });

  it("puts apps without a project under a named fallback", () => {
    const { orgs } = groupServerApps([app("loose", { projectId: null, projectName: null })]);
    expect(orgs[0].projects[0].name).toBe("No project");
  });
});
