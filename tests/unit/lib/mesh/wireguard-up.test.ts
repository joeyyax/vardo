import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));

import { ensureWireguardRunning, parseSquatters, parseWgInspect } from "@/lib/mesh/wireguard-up";

/** A fake Docker host: vardo-wireguard pinned to 10.88.0.2 on vardo_mesh, and the mesh's other members. */
function host(state: { exists?: boolean; running: boolean; mesh: Record<string, string> }) {
  const calls: string[][] = [];
  mockExec.mockImplementation(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "inspect") {
      if (state.exists === false) throw new Error("No such object");
      return { stdout: `${state.running} vardo-network= vardo_internal= vardo_mesh=10.88.0.2\n` };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: Object.entries(state.mesh).map(([n, ip]) => `${n} ${ip}/24\n`).join("") };
    }
    if (args[0] === "network" && args[1] === "disconnect") {
      delete state.mesh[args[3]];
      return { stdout: "" };
    }
    if (args[0] === "network" && args[1] === "connect") {
      const taken = new Set(Object.values(state.mesh));
      let n = 3;
      while (taken.has(`10.88.0.${n}`)) n++;
      state.mesh[args[3]] = `10.88.0.${n}`;
      return { stdout: "" };
    }
    if (args[0] === "start") {
      if (Object.values(state.mesh).includes("10.88.0.2")) {
        throw new Error("failed to set up container networking: Address already in use");
      }
      state.mesh["vardo-wireguard"] = "10.88.0.2";
      state.running = true;
      return { stdout: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  });
  return { state, calls };
}

beforeEach(() => {
  mockExec.mockReset();
});

describe("parseWgInspect", () => {
  it("keeps only networks with a fixed address", () => {
    expect(parseWgInspect("false vardo-network= vardo_mesh=10.88.0.2\n")).toEqual({
      running: false,
      fixed: [{ network: "vardo_mesh", ip: "10.88.0.2" }],
    });
  });
});

describe("parseSquatters", () => {
  it("finds other containers on the fixed address", () => {
    const out = "vardo-mesh-builder 10.88.0.2/24\nvardo-production-blue-frontend-1 10.88.0.3/24\n";
    expect(parseSquatters(out, { network: "vardo_mesh", ip: "10.88.0.2" })).toEqual([
      { network: "vardo_mesh", name: "vardo-mesh-builder", ip: "10.88.0.2" },
    ]);
  });
});

describe("ensureWireguardRunning", () => {
  it("leaves a running container alone", async () => {
    const { calls } = host({ running: true, mesh: { "vardo-wireguard": "10.88.0.2" } });
    expect(await ensureWireguardRunning()).toBe("running");
    expect(calls).toHaveLength(1);
  });

  it("does nothing without a WireGuard container", async () => {
    host({ exists: false, running: false, mesh: {} });
    expect(await ensureWireguardRunning()).toBe("absent");
  });

  it("moves the builder off the gateway address, starts WireGuard and reconnects the builder", async () => {
    const { state } = host({
      running: false,
      mesh: { "vardo-mesh-builder": "10.88.0.2", "vardo-production-blue-frontend-1": "10.88.0.3" },
    });

    expect(await ensureWireguardRunning()).toBe("started");
    expect(state.running).toBe(true);
    expect(state.mesh["vardo-wireguard"]).toBe("10.88.0.2");
    expect(state.mesh["vardo-mesh-builder"]).toBe("10.88.0.4");
    expect(state.mesh["vardo-production-blue-frontend-1"]).toBe("10.88.0.3");
  });

  it("reconnects the squatter when the start still fails", async () => {
    const { state } = host({ running: false, mesh: { "vardo-mesh-builder": "10.88.0.2" } });
    const impl = mockExec.getMockImplementation()!;
    mockExec.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "start") throw new Error("port is already allocated");
      return impl(file, args);
    });

    expect(await ensureWireguardRunning()).toBe("failed");
    expect(state.running).toBe(false);
    expect(state.mesh["vardo-mesh-builder"]).toBeDefined();
  });
});
