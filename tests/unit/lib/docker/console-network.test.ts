import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

import { isolateConsole, planIsolation, type ContainerView, type IsolationDeps } from "@/lib/docker/console-network";

const view = (id: string, networks: string[], labels: Record<string, string> = {}): ContainerView => ({
  Id: id,
  Config: { Labels: labels },
  NetworkSettings: { Networks: Object.fromEntries(networks.map((n) => [n, {}])) },
});
const routed = { "traefik.docker.network": "vardo_console" };

describe("planIsolation", () => {
  it("joins, attaches Traefik, then leaves vardo-network, in that order", () => {
    const self = view("c", ["vardo-network", "vardo_internal"], routed);
    expect(planIsolation(self, view("t", ["vardo-network"])).steps).toEqual(["join-console", "attach-traefik", "leave-vardo-network"]);
  });

  it("only leaves vardo-network once everything else is in place", () => {
    const self = view("c", ["vardo-network", "vardo_console"], routed);
    expect(planIsolation(self, view("t", ["vardo-network", "vardo_console"])).steps).toEqual(["leave-vardo-network"]);
  });

  it("does nothing when already isolated", () => {
    const self = view("c", ["vardo_console", "vardo_internal"], routed);
    expect(planIsolation(self, view("t", ["vardo-network", "vardo_console"]))).toEqual({ steps: [] });
  });

  it("leaves a console Traefik reaches on vardo-network alone", () => {
    const plan = planIsolation(view("c", ["vardo-network"]), view("t", ["vardo-network"]));
    expect(plan.steps).toEqual([]);
    expect(plan.skipped).toMatch(/default network/);
  });

  it("leaves the console alone without a Traefik container", () => {
    expect(planIsolation(view("c", ["vardo-network"], routed), null).steps).toEqual([]);
  });

  it("skips outside a container", () => {
    expect(planIsolation(null, null).skipped).toBe("not in a container");
  });
});

function fakeDeps(containers: Record<string, ContainerView>, fail?: string): IsolationDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    self: () => "c",
    traefik: async () => "t",
    inspect: async (id) => containers[id] ?? null,
    ensureNetwork: async (name) => void calls.push(`ensure ${name}`),
    connect: async (net, id) => {
      if (fail === `connect ${net} ${id}`) throw new Error("refused");
      calls.push(`connect ${net} ${id}`);
    },
    disconnect: async (net, id) => void calls.push(`disconnect ${net} ${id}`),
  };
}

describe("isolateConsole", () => {
  it("applies the plan against Docker", async () => {
    const deps = fakeDeps({ c: view("c", ["vardo-network"], routed), t: view("t", ["vardo-network"]) });
    await isolateConsole(deps);
    expect(deps.calls).toEqual(["ensure vardo_console", "connect vardo_console c", "connect vardo_console t", "disconnect vardo-network c"]);
  });

  it("stays on vardo-network when Traefik can't be attached", async () => {
    const deps = fakeDeps({ c: view("c", ["vardo-network", "vardo_console"], routed), t: view("t", ["vardo-network"]) }, "connect vardo_console t");
    await expect(isolateConsole(deps)).rejects.toThrow("refused");
    expect(deps.calls.some((c) => c.startsWith("disconnect"))).toBe(false);
  });
});
