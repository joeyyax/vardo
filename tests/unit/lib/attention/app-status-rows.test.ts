import { describe, it, expect } from "vitest";

import {
  APP_DOWN_WINDOW_HOURS,
  appStatusRows,
  appStoppedRows,
  withParentNames,
  type StatusSubject,
} from "@/lib/attention/app-status-rows";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const WINDOW = APP_DOWN_WINDOW_HOURS * 3_600_000;

function app(overrides: Partial<StatusSubject> & { name: string }): StatusSubject {
  return {
    id: `app-${overrides.name}`,
    displayName: overrides.name,
    status: "active",
    statusChangedAt: null,
    parked: false,
    parentAppId: null,
    ...overrides,
  };
}

const justNow = new Date(NOW - 3_600_000);
const longAgo = new Date(NOW - (APP_DOWN_WINDOW_HOURS + 1) * 3_600_000);

function rows(apps: StatusSubject[]) {
  return appStatusRows(apps, NOW, WINDOW);
}

describe("appStatusRows", () => {
  it("reports an app that broke inside the window", () => {
    const [row] = rows([app({ name: "hub", displayName: "Hub", status: "missing", statusChangedAt: justNow })]);

    expect(row).toMatchObject({ key: "app-down", label: "App down", tone: "error" });
    expect(row.items).toEqual([
      {
        id: "app-hub",
        name: "Hub",
        href: "/apps/hub",
        detail: "No container on the host",
        since: justNow.toISOString(),
      },
    ]);
  });

  it("calls a failed container what it is", () => {
    const [row] = rows([app({ name: "hub", status: "error", statusChangedAt: justNow })]);

    expect(row.items[0].detail).toBe("Container failed");
  });

  it("reports an app that has never transitioned, without inventing a duration", () => {
    const [row] = rows([app({ name: "hub", status: "missing", statusChangedAt: null })]);

    expect(row.items).toHaveLength(1);
    expect(row.items[0].detail).toBe("No container on the host");
    expect(row.items[0].since).toBeUndefined();
  });

  it("stays quiet on a parked app however broken it reads", () => {
    expect(
      rows([
        app({ name: "lonvr", status: "missing", statusChangedAt: justNow, parked: true }),
        app({ name: "encoder", status: "error", statusChangedAt: justNow, parked: true }),
        app({ name: "jellyfin", status: "missing", statusChangedAt: null, parked: true }),
      ]),
    ).toEqual([]);
  });

  it("stays quiet once a transition ages out of the window", () => {
    expect(rows([app({ name: "lonvr", status: "missing", statusChangedAt: longAgo })])).toEqual([]);
  });

  it("stays quiet on a stopped app, which is deliberate", () => {
    expect(rows([app({ name: "hub", status: "stopped", statusChangedAt: justNow })])).toEqual([]);
  });

  it("stays quiet on a healthy app", () => {
    expect(rows([app({ name: "hub", status: "active", statusChangedAt: justNow })])).toEqual([]);
  });

  it("names a broken child under its parent", () => {
    const parent = app({ name: "agents", displayName: "Agents" });
    const [row] = rows([
      parent,
      app({
        name: "agents-postgres",
        displayName: "Postgres",
        status: "missing",
        statusChangedAt: justNow,
        parentAppId: parent.id,
      }),
    ]);

    expect(row.items).toHaveLength(1);
    expect(row.items[0]).toMatchObject({ name: "Agents · Postgres", href: "/apps/agents-postgres" });
  });

  it("stays quiet on a child while its parent is deploying", () => {
    const parent = app({ name: "agents", displayName: "Agents", status: "deploying" });

    expect(
      rows([
        parent,
        app({
          name: "agents-postgres",
          status: "missing",
          statusChangedAt: justNow,
          parentAppId: parent.id,
        }),
      ]),
    ).toEqual([]);
  });

  it("collapses a cascade to the parent alone", () => {
    const parent = app({
      name: "lonvr",
      displayName: "Lonvr",
      status: "missing",
      statusChangedAt: justNow,
    });
    const children = ["postgres", "redis", "worker"].map((service) =>
      app({
        name: `lonvr-${service}`,
        displayName: service,
        status: "missing",
        statusChangedAt: justNow,
        parentAppId: parent.id,
      }),
    );

    const [row] = rows([parent, ...children]);

    expect(row.items).toHaveLength(1);
    expect(row.items[0].name).toBe("Lonvr");
  });

  it("keeps a broken child when its parent is fine", () => {
    const parent = app({ name: "glitchtip", displayName: "GlitchTip" });
    const [row] = rows([
      parent,
      app({
        name: "glitchtip-web",
        displayName: "Web",
        status: "error",
        statusChangedAt: justNow,
        parentAppId: parent.id,
      }),
    ]);

    expect(row.items.map((i) => i.name)).toEqual(["GlitchTip · Web"]);
  });
});

describe("appStoppedRows", () => {
  function stack(name: string, displayName: string, services: string[]) {
    const parent = app({ name, displayName, status: "stopped", statusChangedAt: justNow });
    return [
      parent,
      ...services.map((service) =>
        app({
          name: `${name}-${service}`,
          displayName: service,
          status: "stopped",
          statusChangedAt: justNow,
          parentAppId: parent.id,
        }),
      ),
    ];
  }

  it("reports a stopped app with no window to age out of", () => {
    const [row] = appStoppedRows([
      app({ name: "jellyfin", displayName: "Jellyfin", status: "stopped", statusChangedAt: longAgo }),
    ]);

    expect(row).toMatchObject({ key: "app-stopped", label: "Stopped", tone: "neutral" });
    expect(row.items).toEqual([
      {
        id: "app-jellyfin",
        name: "Jellyfin",
        href: "/apps/jellyfin",
        since: longAgo.toISOString(),
      },
    ]);
  });

  it("collapses a stopped stack to one row carrying the service count", () => {
    const [row] = appStoppedRows(stack("agents", "Agents", ["postgres", "redis", "worker", "web", "api"]));

    expect(row.items).toHaveLength(1);
    expect(row.items[0]).toMatchObject({ name: "Agents", href: "/apps/agents", detail: "5 services" });
  });

  it("counts a single collapsed service in the singular", () => {
    const [row] = appStoppedRows(stack("encoder", "Encoder", ["worker"]));

    expect(row.items[0].detail).toBe("1 service");
  });

  it("leaves a standalone app without a service count", () => {
    const [row] = appStoppedRows([app({ name: "lonvr", displayName: "Lonvr", status: "stopped" })]);

    expect(row.items[0].detail).toBeUndefined();
  });

  it("keeps a stopped service named under its running parent", () => {
    const parent = app({ name: "agents", displayName: "Agents", status: "active" });
    const [row] = appStoppedRows([
      parent,
      app({ name: "agents-worker", displayName: "Worker", status: "stopped", parentAppId: parent.id }),
    ]);

    expect(row.items.map((i) => i.name)).toEqual(["Agents · Worker"]);
  });

  it("stays quiet on a child while its parent is deploying", () => {
    const parent = app({ name: "agents", displayName: "Agents", status: "deploying" });

    expect(
      appStoppedRows([
        parent,
        app({ name: "agents-web", status: "stopped", parentAppId: parent.id }),
      ]),
    ).toEqual([]);
  });

  it("omits a stamp the app has never had", () => {
    const [row] = appStoppedRows([app({ name: "lonvr", status: "stopped", statusChangedAt: null })]);

    expect(row.items[0].since).toBeUndefined();
  });

  it("stays quiet when nothing is stopped", () => {
    expect(appStoppedRows([app({ name: "hub", status: "active" })])).toEqual([]);
  });

  it("says a parked app is parked rather than dropping it from the inventory", () => {
    const [row] = appStoppedRows([
      app({ name: "lonvr", displayName: "Lonvr", status: "stopped", parked: true }),
    ]);

    expect(row.items[0]).toMatchObject({ name: "Lonvr", detail: "parked" });
  });

  it("reads parked alongside the service count on a collapsed stack", () => {
    const [row] = appStoppedRows(
      stack("agents", "Agents", ["postgres", "redis", "worker", "web", "api"]).map((a) => ({
        ...a,
        parked: true,
      })),
    );

    expect(row.items).toHaveLength(1);
    expect(row.items[0].detail).toBe("parked · 5 services");
  });
});

// ---------------------------------------------------------------------------
// The board on the day the flag lands.
//
// Every app already off on purpose has a null stamp, which is the only reason
// the App-down row is quiet about it today. That accident is now the flag's
// job, and these hold the two to the same answer.
// ---------------------------------------------------------------------------
describe("day one", () => {
  const shelved = [
    app({ name: "lonvr", displayName: "Reeve NVR", status: "missing", parked: true }),
    app({ name: "encoder", displayName: "Encoder", status: "missing", parked: true }),
    app({ name: "jellyfin", displayName: "Jellyfin", status: "missing", parked: true }),
  ];
  const agents = app({ name: "agents", displayName: "Agents", status: "stopped", parked: true });
  const agentServices = ["bot", "dashboard", "postgres", "redis", "worker"].map((service) =>
    app({
      name: `agents-${service}`,
      displayName: service,
      status: "stopped",
      parked: true,
      parentAppId: agents.id,
    }),
  );
  // Genuinely broken, an hour ago, and nobody has declared anything about it.
  const glitchtip = app({
    name: "glitchtip",
    displayName: "GlitchTip",
    status: "missing",
    statusChangedAt: justNow,
  });
  const board = [...shelved, agents, ...agentServices, glitchtip];

  it("says nothing new about a shelved stack", () => {
    const [row] = rows(board);

    expect(row.items.map((i) => i.name)).toEqual(["GlitchTip"]);
  });

  it("keeps the shelved stack in the inventory, now saying why", () => {
    const [row] = appStoppedRows(board);

    expect(row.items).toHaveLength(1);
    expect(row.items[0]).toMatchObject({ name: "Agents", detail: "parked · 5 services" });
    expect(row.items[0].since).toBeUndefined();
  });

  it("would have gone loud on all three had they not been parked", () => {
    const [row] = rows(board.map((a) => ({ ...a, parked: false })));

    expect(row.items.map((i) => i.name).sort()).toEqual([
      "Encoder",
      "GlitchTip",
      "Jellyfin",
      "Reeve NVR",
    ]);
  });
});

describe("withParentNames", () => {
  it("qualifies a child with its parent and leaves a parent alone", () => {
    const parent = app({ name: "agents", displayName: "Agents" });
    const child = app({ name: "agents-redis", displayName: "Redis", parentAppId: parent.id });

    expect(withParentNames([parent, child]).map((a) => a.displayName)).toEqual([
      "Agents",
      "Agents · Redis",
    ]);
  });
});
