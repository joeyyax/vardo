import { describe, it, expect } from "vitest";

import {
  APP_DOWN_WINDOW_HOURS,
  appStatusRows,
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

  it("stays quiet on an app that has never transitioned", () => {
    expect(rows([app({ name: "lonvr", status: "missing", statusChangedAt: null })])).toEqual([]);
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
