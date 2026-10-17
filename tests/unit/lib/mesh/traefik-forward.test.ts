// The tunnel's DNAT of ports 80 and 443 to Traefik, beside the console's and the SSH endpoint's.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExec, rebuild } = vi.hoisted(() => ({ mockExec: vi.fn(), rebuild: vi.fn() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));
vi.mock("@/lib/mesh/env", () => ({ isRunningInContainer: () => true }));
vi.mock("@/lib/mesh/wireguard", async (orig) => ({ ...(await orig<typeof import("@/lib/mesh/wireguard")>()), rebuildAndSync: rebuild }));

import { reconcileTraefikForward, traefikForwardHooks } from "@/lib/mesh/traefik-forward";
import { buildWgConfig } from "@/lib/mesh/wireguard";

const PRIVATE = "a".repeat(43) + "=";
const calls = () => mockExec.mock.calls.map((c) => (c[1] as string[]).join(" "));

function docker(a: { inspect?: string; conf?: string; rules?: string[] }) {
  mockExec.mockImplementation(async (_file: string, args: string[]) => {
    const line = args.join(" ");
    if (args[0] === "inspect") return { stdout: a.inspect ?? "", stderr: "" };
    if (line.includes("grep -o")) return { stdout: a.conf ?? "missing\n", stderr: "" };
    if (line.includes("-S PREROUTING")) return { stdout: ["-P PREROUTING ACCEPT", ...(a.rules ?? [])].join("\n"), stderr: "" };
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => {
  mockExec.mockReset();
  rebuild.mockReset();
});

describe("traefikForwardHooks", () => {
  it("DNATs 80 and 443 to Traefik, lets them through and masquerades the replies", () => {
    const { postUp, postDown } = traefikForwardHooks("172.18.0.5");
    for (const port of ["80", "443"]) {
      expect(postUp).toContain(`iptables -t nat -A PREROUTING -i wg0 -p tcp --dport ${port} -j DNAT --to-destination 172.18.0.5:${port}`);
      expect(postUp).toContain(`iptables -A FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT`);
      expect(postUp).toContain(`iptables -t nat -A POSTROUTING -d 172.18.0.5 -p tcp --dport ${port} -j MASQUERADE`);
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
  const rule = (ip: string, port: string) => `-A PREROUTING -i wg0 -p tcp -m tcp --dport ${port} -j DNAT --to-destination ${ip}:${port}`;

  it("does nothing when Traefik isn't running", async () => {
    docker({ inspect: "false " });
    expect(await reconcileTraefikForward()).toEqual({ state: "absent" });
  });

  it("leaves a correct forward alone", async () => {
    docker({ inspect: "true 172.18.0.5", conf: "--to-destination 172.18.0.5:443\n", rules: [rule("172.18.0.5", "80"), rule("172.18.0.5", "443")] });
    expect(await reconcileTraefikForward()).toEqual({ state: "ok", target: "172.18.0.5" });
    expect(calls().some((c) => c.includes("-A PREROUTING"))).toBe(false);
  });

  it("rewrites a forward that points at an old Traefik address", async () => {
    docker({ inspect: "true 172.18.0.9", conf: "--to-destination 172.18.0.5:443\n", rules: [rule("172.18.0.5", "80"), rule("172.18.0.5", "443")] });
    const result = await reconcileTraefikForward();
    expect(result).toMatchObject({ state: "repaired", target: "172.18.0.9" });
    expect(calls().some((c) => c.includes("-t nat -A PREROUTING -i wg0 -p tcp --dport 443 -j DNAT --to-destination 172.18.0.9:443"))).toBe(true);
    expect(calls().some((c) => c.includes("-t nat -D PREROUTING"))).toBe(true);
  });

  it("writes the hooks into a wg0.conf that predates them", async () => {
    docker({ inspect: "true 172.18.0.5", conf: "\n" });
    await reconcileTraefikForward();
    expect(rebuild).toHaveBeenCalled();
  });

  it("stays off when switched off", async () => {
    vi.stubEnv("VARDO_MESH_TRAEFIK_FORWARD", "false");
    expect(await reconcileTraefikForward()).toEqual({ state: "disabled" });
    vi.unstubAllEnvs();
  });
});
