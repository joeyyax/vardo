import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: null as unknown,
  tables: new Map<string, string>(),
}));

vi.mock("@/lib/docker/client", () => ({
  dockerRequest: async (_method: string, path: string) => {
    if (path.includes("/top")) return { Titles: ["PID", "COMMAND", "%CPU", "RSS"], Processes: [["4100", "plex", "1.0", "2048"], ["4200", "worker", "0.5", "1024"]] };
    if (mocks.inspect instanceof Error) throw mocks.inspect;
    return mocks.inspect;
  },
}));

vi.mock("fs/promises", () => ({
  readFile: async (path: string) => {
    const table = mocks.tables.get(path);
    if (table === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return table;
  },
}));

const { appPorts, probeContainer } = await import("@/lib/anomaly/probe");

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
// 0.0.0.0:32400 and 0.0.0.0:445 listening.
const TCP = [HEADER, "   0: 00000000:7E90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111", "   1: 00000000:01BD 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222"].join("\n");

beforeEach(() => {
  mocks.tables.clear();
  mocks.inspect = { State: { Pid: 4100 }, HostConfig: { NetworkMode: "bridge" } };
});

describe("probeContainer", () => {
  it("reads ports from the container's own network namespace", async () => {
    mocks.tables.set("/host-proc/4100/net/tcp", TCP);
    const probe = await probeContainer("abc");
    expect(probe.hostNetwork).toBe(false);
    expect(probe.ports?.sort()).toEqual(["tcp/32400", "tcp/445"]);
    expect(probe.processes.map((p) => p.name)).toEqual(["plex", "worker"]);
  });

  it("reports no ports for a host-network container, whose table is the whole host's", async () => {
    mocks.inspect = { State: { Pid: 4100 }, HostConfig: { NetworkMode: "host" } };
    mocks.tables.set("/host-proc/4100/net/tcp", TCP);
    const probe = await probeContainer("abc");
    expect(probe).toMatchObject({ hostNetwork: true, ports: null });
    expect(probe.processes).toHaveLength(2);
  });

  it("reports no ports for a container on another's network, whose table is the owner's", async () => {
    // Long House: Port Sync runs with `network_mode: service:gluetun`.
    mocks.inspect = { State: { Pid: 4100 }, HostConfig: { NetworkMode: "container:65bcc5b5350843e28ca24dc5816af2374b76c2348e3272c8b57f3df661950bde" } };
    mocks.tables.set("/host-proc/4100/net/tcp", TCP);
    const probe = await probeContainer("abc");
    expect(probe).toMatchObject({ sharedNetwork: true, hostNetwork: false, ports: null });
    expect(probe.processes).toHaveLength(2);
  });

  it("reports no ports when the tables can't be read", async () => {
    expect((await probeContainer("abc")).ports).toBeNull();
  });

  it("reports no ports when the container can't be inspected", async () => {
    mocks.inspect = new Error("timeout");
    mocks.tables.set("/host-proc/4100/net/tcp", TCP);
    const probe = await probeContainer("abc");
    expect(probe).toMatchObject({ hostNetwork: false, ports: null });
    expect(probe.processes).toHaveLength(2);
  });
});

describe("appPorts", () => {
  const probe = (ports: string[] | null, hostNetwork = false, sharedNetwork = false) => ({ processes: [], ports, hostNetwork, sharedNetwork });
  const sidecar = () => probe(null, false, true);

  it("folds every container's ports", () => {
    expect(appPorts([probe(["tcp/80"]), probe(["tcp/80", "udp/53"])], 2)).toEqual({ action: "fold", ports: ["tcp/80", "udp/53"] });
  });

  it("forgets the allow-set of a host-network app", () => {
    expect(appPorts([probe(null, true)], 1)).toEqual({ action: "forget" });
  });

  it("skips when a container's ports couldn't be read", () => {
    expect(appPorts([probe(["tcp/80"]), probe(null)], 2)).toEqual({ action: "skip" });
  });

  it("skips when a container couldn't be probed", () => {
    expect(appPorts([probe(["tcp/80"])], 2)).toEqual({ action: "skip" });
  });

  it("forgets the allow-set of an app on another container's network, which the owner's check covers", () => {
    expect(appPorts([sidecar()], 1)).toEqual({ action: "forget" });
  });

  it("folds only the namespace owner's ports when its sidecar shares the app", () => {
    expect(appPorts([probe(["tcp/8000"]), sidecar()], 2)).toEqual({ action: "fold", ports: ["tcp/8000"] });
  });

  it("skips a sidecar app when one of its containers couldn't be probed", () => {
    expect(appPorts([sidecar()], 2)).toEqual({ action: "skip" });
  });
});
