// The tunnel's DNAT of ports 80 and 443 to Traefik, limited to mesh addresses and present only while a peer may check this instance.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExec, rebuild, allowed } = vi.hoisted(() => ({ mockExec: vi.fn(), rebuild: vi.fn(), allowed: { value: true } }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));
vi.mock("@/lib/mesh/env", () => ({ isRunningInContainer: () => true }));
vi.mock("@/lib/db", () => ({ db: { query: { meshPeers: { findFirst: async () => (allowed.value ? { id: "p" } : undefined) } } } }));
vi.mock("@/lib/mesh/wireguard", async (orig) => ({ ...(await orig<typeof import("@/lib/mesh/wireguard")>()), rebuildAndSync: rebuild }));

import { MESH_SUBNET, reconcileTraefikForward, traefikForwardHooks } from "@/lib/mesh/traefik-forward";
import { buildWgConfig } from "@/lib/mesh/wireguard";

const PRIVATE = "a".repeat(43) + "=";
const calls = () => mockExec.mock.calls.map((c) => (c[1] as string[]).join(" "));

function docker(a: { inspect?: string; conf?: string; rules?: string[]; post?: string[] }) {
  mockExec.mockImplementation(async (_file: string, args: string[]) => {
    const line = args.join(" ");
    if (args[0] === "inspect") return { stdout: a.inspect ?? "", stderr: "" };
    if (line.includes("grep -o")) return { stdout: a.conf ?? "missing\n", stderr: "" };
    if (line.includes("-S PREROUTING")) return { stdout: ["-P PREROUTING ACCEPT", ...(a.rules ?? [])].join("\n"), stderr: "" };
    if (line.includes("-S POSTROUTING")) return { stdout: ["-P POSTROUTING ACCEPT", ...(a.post ?? [])].join("\n"), stderr: "" };
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => {
  mockExec.mockReset();
  rebuild.mockReset();
  allowed.value = true;
});

describe("traefikForwardHooks", () => {
  it("DNATs 80 and 443 from the mesh subnet to Traefik, lets them through and masquerades the replies", () => {
    expect(MESH_SUBNET).toBe("10.99.0.0/24");
    const { postUp, postDown } = traefikForwardHooks("172.18.0.5");
    for (const port of ["80", "443"]) {
      expect(postUp).toContain(`iptables -t nat -A PREROUTING -s ${MESH_SUBNET} -i wg0 -p tcp --dport ${port} -j DNAT --to-destination 172.18.0.5:${port}`);
      expect(postUp).toContain(`iptables -A FORWARD -s ${MESH_SUBNET} -i wg0 -p tcp --dport ${port} -j ACCEPT`);
      expect(postUp).toContain(`iptables -t nat -A POSTROUTING -s ${MESH_SUBNET} -d 172.18.0.5 -p tcp --dport ${port} -j MASQUERADE`);
    }
    expect(postDown).toContain("-D PREROUTING");
    expect(() => traefikForwardHooks("172.18.0.5; reboot")).toThrow();
  });

  it("sits beside the other forwards in wg0.conf", () => {
    const conf = buildWgConfig(PRIVATE, 51820, "10.99.0.2", [], "10.88.0.3", "10.88.0.7", "172.18.0.5");
    expect(conf.split("\n").filter((l) => l.startsWith("PostUp = "))).toHaveLength(3);
    expect(buildWgConfig(PRIVATE, 51820, "10.99.0.2", [], "10.88.0.3").split("\n").filter((l) => l.startsWith("PostUp = "))).toHaveLength(1);
  });
});

describe("reconcileTraefikForward", () => {
  const rule = (ip: string, port: string, scoped = true) =>
    `-A PREROUTING ${scoped ? `-s ${MESH_SUBNET} ` : ""}-i wg0 -p tcp -m tcp --dport ${port} -j DNAT --to-destination ${ip}:${port}`;

  it("does nothing when Traefik isn't running", async () => {
    docker({ inspect: "false " });
    expect(await reconcileTraefikForward()).toEqual({ state: "absent" });
  });

  it("leaves a correct forward alone", async () => {
    docker({ inspect: "true 172.18.0.5", conf: "--to-destination 172.18.0.5:443\n", rules: [rule("172.18.0.5", "80"), rule("172.18.0.5", "443")] });
    expect(await reconcileTraefikForward()).toEqual({ state: "ok", target: "172.18.0.5" });
    expect(calls().some((c) => c.includes("-A PREROUTING") && !c.includes("-C"))).toBe(false);
  });

  it("replaces a forward that points at an old Traefik address or isn't limited to the mesh", async () => {
    docker({ inspect: "true 172.18.0.9", conf: "--to-destination 172.18.0.5:443\n", rules: [rule("172.18.0.5", "80"), rule("172.18.0.9", "443", false)] });
    expect(await reconcileTraefikForward()).toMatchObject({ state: "repaired", target: "172.18.0.9" });
    expect(rebuild).toHaveBeenCalled();
    expect(calls().filter((c) => c.includes("-t nat -D PREROUTING"))).toHaveLength(2);
    expect(calls().filter((c) => c.includes(`-t nat -A PREROUTING -s ${MESH_SUBNET} -i wg0`))).toHaveLength(2);
  });

  it("writes the hooks into a wg0.conf that predates them", async () => {
    docker({ inspect: "true 172.18.0.5", conf: "\n" });
    await reconcileTraefikForward();
    expect(rebuild).toHaveBeenCalled();
  });

  it("removes the rules and hooks when no peer may check this instance", async () => {
    allowed.value = false;
    docker({
      conf: "--to-destination 172.18.0.5:443\n",
      rules: [rule("172.18.0.5", "80"), rule("172.18.0.5", "443")],
      post: [`-A POSTROUTING -s ${MESH_SUBNET} -d 172.18.0.5/32 -p tcp -m tcp --dport 443 -j MASQUERADE`],
    });
    const result = await reconcileTraefikForward();
    expect(result).toMatchObject({ state: "removed" });
    expect(calls().filter((c) => c.includes("-t nat -D PREROUTING"))).toHaveLength(2);
    expect(calls().some((c) => c.includes("-t nat -D POSTROUTING"))).toBe(true);
    expect(rebuild).toHaveBeenCalled();
    expect(calls().some((c) => c.startsWith("inspect"))).toBe(false);
  });

  it("is off, and touches nothing, when there is nothing to remove", async () => {
    allowed.value = false;
    docker({ conf: "\n" });
    expect(await reconcileTraefikForward()).toEqual({ state: "off" });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("stays off when switched off", async () => {
    vi.stubEnv("VARDO_MESH_TRAEFIK_FORWARD", "false");
    expect(await reconcileTraefikForward()).toEqual({ state: "disabled" });
    vi.unstubAllEnvs();
  });
});
