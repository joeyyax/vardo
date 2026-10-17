// The mesh SSH port's DNAT in vardo-wireguard, beside the console's, written into wg0.conf and kept live.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec, rebuild } = vi.hoisted(() => ({ mockExec: vi.fn(), rebuild: vi.fn() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));
vi.mock("@/lib/mesh/env", () => ({ isRunningInContainer: () => true }));
vi.mock("@/lib/mesh/wireguard", async (orig) => ({ ...(await orig<typeof import("@/lib/mesh/wireguard")>()), rebuildAndSync: rebuild }));

import { reconcileSshForward, sshForwardHooks } from "@/lib/mesh/ssh-forward";
import { buildWgConfig } from "@/lib/mesh/wireguard";
import { parseForwardRules } from "@/lib/mesh/console-forward";

const PRIVATE = "a".repeat(43) + "=";
const CONSOLE_RULE = "-A PREROUTING -i wg0 -p tcp -m tcp --dport 3000 -j DNAT --to-destination 10.88.0.3:3000";
const SSH_RULE = (ip: string) => `-A PREROUTING -i wg0 -p tcp -m tcp --dport 22 -j DNAT --to-destination ${ip}:22`;

type Answers = { inspect?: string; conf?: string; rules?: string[] };
const calls = () => mockExec.mock.calls.map((c) => (c[1] as string[]).join(" "));

function docker(a: Answers) {
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

describe("sshForwardHooks", () => {
  it("DNATs the SSH port to the endpoint and lets it through, without a second masquerade", () => {
    const { postUp, postDown } = sshForwardHooks("10.88.0.7");
    expect(postUp).toBe(
      "iptables -t nat -A PREROUTING -i wg0 -p tcp --dport 22 -j DNAT --to-destination 10.88.0.7:22; iptables -A FORWARD -i wg0 -p tcp --dport 22 -j ACCEPT",
    );
    expect(postDown).toContain("-D PREROUTING");
    expect(() => sshForwardHooks("10.88.0.7; reboot")).toThrow();
  });

  it("sits beside the console forward in wg0.conf, which keeps its own rules", () => {
    const conf = buildWgConfig(PRIVATE, 51820, "10.99.0.2", [], "10.88.0.3", "10.88.0.7");
    const postUps = conf.split("\n").filter((l) => l.startsWith("PostUp = "));
    expect(postUps).toHaveLength(2);
    expect(postUps[0]).toContain("--to-destination 10.88.0.3:3000");
    expect(postUps[1]).toContain("--to-destination 10.88.0.7:22");
    expect(buildWgConfig(PRIVATE, 51820, "10.99.0.2", [], "10.88.0.3").match(/--dport 22/)).toBeNull();
  });

  it("doesn't count as the console's rule, or the console's as its own", () => {
    const out = [CONSOLE_RULE, SSH_RULE("10.88.0.7")].join("\n");
    expect(parseForwardRules(out).map((r) => r.ip)).toEqual(["10.88.0.3"]);
    expect(parseForwardRules(out, "22").map((r) => r.ip)).toEqual(["10.88.0.7"]);
  });
});

describe("reconcileSshForward", () => {
  it("does nothing while the endpoint isn't running", async () => {
    docker({ inspect: "false 10.88.0.7 " });
    expect(await reconcileSshForward()).toEqual({ state: "absent" });
    expect(calls().some((c) => c.includes("iptables"))).toBe(false);
  });

  it("waits for the mesh to be set up", async () => {
    docker({ inspect: "true 10.88.0.7 172.18.0.4 ", conf: "missing\n" });
    expect(await reconcileSshForward()).toEqual({ state: "unconfigured" });
  });

  it("adds the hooks and live rule to an install whose wg0.conf predates them", async () => {
    docker({ inspect: "true 172.18.0.4 10.88.0.7 ", conf: "\n", rules: [CONSOLE_RULE] });
    const result = await reconcileSshForward();
    expect(result).toMatchObject({ state: "repaired", target: "10.88.0.7" });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(calls()).toContain("exec vardo-wireguard iptables -t nat -A PREROUTING -i wg0 -p tcp --dport 22 -j DNAT --to-destination 10.88.0.7:22");
    expect(calls().some((c) => c.includes("-D PREROUTING") && c.includes("3000"))).toBe(false);
  });

  it("follows the endpoint to a new address after a recreate", async () => {
    docker({ inspect: "true 10.88.0.9 ", conf: "--to-destination 10.88.0.7:22\n", rules: [CONSOLE_RULE, SSH_RULE("10.88.0.7")] });
    expect(await reconcileSshForward()).toMatchObject({ state: "repaired", target: "10.88.0.9" });
    expect(rebuild).not.toHaveBeenCalled();
    expect(calls().find((c) => c.includes("sed -i"))).toContain("--to-destination 10.88.0.9:22");
    expect(calls().some((c) => c.includes("-D PREROUTING") && c.includes("10.88.0.7:22"))).toBe(true);
  });

  it("is ok when everything already points at the endpoint", async () => {
    docker({ inspect: "true 10.88.0.7 ", conf: "--to-destination 10.88.0.7:22\n", rules: [CONSOLE_RULE, SSH_RULE("10.88.0.7")] });
    expect(await reconcileSshForward()).toEqual({ state: "ok", target: "10.88.0.7" });
  });
});
