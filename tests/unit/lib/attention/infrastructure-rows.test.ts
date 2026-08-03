import { describe, it, expect } from "vitest";

import {
  hasSelfDeploy,
  infrastructureRows,
  SELF_DEPLOY_ROW_KEY,
  type InfraApp,
  type InfrastructureSnapshot,
} from "@/lib/attention/infrastructure-rows";
import type { AppCondition } from "@/lib/docker/conditions";

const ADMIN = { canLinkToAdmin: true };
const MEMBER = { canLinkToAdmin: false };

function app(overrides: Partial<InfraApp> & { name: string }): InfraApp {
  return {
    id: `app-${overrides.name}`,
    displayName: overrides.name,
    status: "active",
    conditions: null,
    ...overrides,
  };
}

const vardo = app({ name: "vardo", displayName: "Vardo" });
const loki = app({ name: "loki", displayName: "Loki" });
const postgres = app({ name: "vardo-postgres", displayName: "Postgres" });

function snapshot(overrides: Partial<InfrastructureSnapshot> = {}): InfrastructureSnapshot {
  return { apps: [vardo, loki, postgres], deployments: [], servicesDown: [], ...overrides };
}

const crashLoop: AppCondition = {
  kind: "crash-looping",
  severity: "critical",
  since: "2026-08-01T00:00:00.000Z",
  detail: "7 restarts in 10 minutes",
};

const memoryPressure: AppCondition = {
  kind: "memory-pressure",
  severity: "warning",
  since: "2026-08-01T00:00:00.000Z",
  detail: "94% of memory limit",
};

describe("infrastructureRows", () => {
  it("says nothing about a healthy instance", () => {
    expect(infrastructureRows(snapshot(), ADMIN)).toEqual([]);
  });

  it("says nothing when there is no infrastructure at all", () => {
    expect(
      infrastructureRows({ apps: [], deployments: [], servicesDown: [] }, ADMIN),
    ).toEqual([]);
  });

  it("reports a Vardo self-deploy as activity, not a fault", () => {
    const rows = infrastructureRows(
      snapshot({
        deployments: [
          {
            id: "deploy-1",
            appId: vardo.id,
            gitSha: "abc1234def",
            startedAt: new Date("2026-08-01T10:00:00Z"),
          },
        ],
      }),
      ADMIN,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: SELF_DEPLOY_ROW_KEY, tone: "activity" });
    expect(rows[0].items[0]).toMatchObject({ id: "deploy-1", name: "Vardo", detail: "abc1234" });
    expect(hasSelfDeploy(rows)).toBe(true);
  });

  it("keeps a core service deploy separate from the self-deploy", () => {
    const rows = infrastructureRows(
      snapshot({
        deployments: [
          { id: "d-vardo", appId: vardo.id, gitSha: null, startedAt: new Date() },
          { id: "d-loki", appId: loki.id, gitSha: null, startedAt: new Date() },
        ],
      }),
      ADMIN,
    );

    expect(rows.map((r) => r.key)).toEqual([SELF_DEPLOY_ROW_KEY, "core-service-updating"]);
  });

  it("keeps only the latest deploy per app", () => {
    const rows = infrastructureRows(
      snapshot({
        deployments: [
          { id: "older", appId: vardo.id, gitSha: null, startedAt: new Date("2026-08-01T09:00:00Z") },
          { id: "newer", appId: vardo.id, gitSha: null, startedAt: new Date("2026-08-01T10:00:00Z") },
        ],
      }),
      ADMIN,
    );

    expect(rows[0].items.map((i) => i.id)).toEqual(["newer"]);
  });

  it("splits a down core service from a degraded Vardo container", () => {
    const rows = infrastructureRows(
      snapshot({
        apps: [vardo, loki, { ...postgres, conditions: [crashLoop] }],
        servicesDown: [{ id: "service-degraded:Loki", name: "Loki", lastFired: "2026-08-01T10:00:00.000Z" }],
      }),
      ADMIN,
    );

    expect(rows.map((r) => r.key)).toEqual(["vardo-stack-degraded", "core-service-down"]);
    expect(rows[0].items[0]).toMatchObject({ name: "Postgres", detail: "7 restarts in 10 minutes" });
    expect(rows[1].items[0]).toMatchObject({ name: "Loki", detail: "Not responding" });
  });

  it("reports a probe failure and the app's own condition as one subject", () => {
    const rows = infrastructureRows(
      snapshot({
        apps: [vardo, { ...loki, status: "error", conditions: [crashLoop] }, postgres],
        servicesDown: [{ id: "service-degraded:Loki", name: "Loki", lastFired: "2026-08-01T10:00:00.000Z" }],
      }),
      ADMIN,
    );

    const items = rows.flatMap((r) => r.items);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(loki.id);
  });

  it("does not call an app broken while it is being deployed", () => {
    const rows = infrastructureRows(
      snapshot({
        apps: [vardo, { ...loki, status: "error" }, postgres],
        deployments: [{ id: "d-loki", appId: loki.id, gitSha: null, startedAt: new Date() }],
        servicesDown: [{ id: "service-degraded:Loki", name: "Loki", lastFired: "2026-08-01T10:00:00.000Z" }],
      }),
      ADMIN,
    );

    expect(rows.map((r) => r.key)).toEqual(["core-service-updating"]);
  });

  // The stack deploy replaces every container in it, so a child flashing
  // missing mid-swap is the deploy, not a fault.
  it("quiets the whole Vardo stack while the stack is deploying", () => {
    const rows = infrastructureRows(
      snapshot({
        apps: [vardo, loki, { ...postgres, status: "missing" }],
        deployments: [{ id: "d-vardo", appId: vardo.id, gitSha: null, startedAt: new Date() }],
        servicesDown: [
          { id: "service-degraded:PostgreSQL", name: "PostgreSQL", lastFired: "2026-08-01T10:00:00.000Z" },
        ],
      }),
      ADMIN,
    );

    expect(rows.map((r) => r.key)).toEqual([SELF_DEPLOY_ROW_KEY]);
  });

  it("still reports a core service while the Vardo stack deploys", () => {
    const rows = infrastructureRows(
      snapshot({
        apps: [vardo, { ...loki, status: "error" }, postgres],
        deployments: [{ id: "d-vardo", appId: vardo.id, gitSha: null, startedAt: new Date() }],
      }),
      ADMIN,
    );

    expect(rows.map((r) => r.key)).toEqual([SELF_DEPLOY_ROW_KEY, "core-service-down"]);
  });

  it("ignores conditions that are not about the container running", () => {
    const rows = infrastructureRows(
      snapshot({ apps: [{ ...postgres, conditions: [memoryPressure] }] }),
      ADMIN,
    );

    expect(rows).toEqual([]);
  });

  it("reports a missing container", () => {
    const rows = infrastructureRows(snapshot({ apps: [{ ...postgres, status: "missing" }] }), ADMIN);

    expect(rows[0]).toMatchObject({ key: "vardo-stack-degraded", tone: "error" });
    expect(rows[0].items[0].detail).toBe("No container on the host");
  });

  it("keeps a probe with no app row, under its own name", () => {
    const rows = infrastructureRows(
      snapshot({
        servicesDown: [{ id: "service-degraded:Docker", name: "Docker", lastFired: "2026-08-01T10:00:00.000Z" }],
      }),
      ADMIN,
    );

    expect(rows[0].items[0]).toMatchObject({ id: "service-degraded:Docker", name: "Docker" });
  });

  it("links to admin for admins and nowhere for everyone else", () => {
    const down = snapshot({
      apps: [vardo, { ...loki, status: "error" }, { ...postgres, status: "error" }],
    });

    const forAdmin = infrastructureRows(down, ADMIN);
    expect(forAdmin.find((r) => r.key === "vardo-stack-degraded")?.items[0].href).toBe("/admin");
    expect(forAdmin.find((r) => r.key === "core-service-down")?.items[0].href).toBe(
      "/admin/settings/core-services",
    );

    const forMember = infrastructureRows(down, MEMBER);
    expect(forMember.flatMap((r) => r.items).every((i) => i.href === undefined)).toBe(true);
  });

  it("reports no self-deploy when nothing is deploying", () => {
    expect(hasSelfDeploy(infrastructureRows(snapshot(), ADMIN))).toBe(false);
  });
});
