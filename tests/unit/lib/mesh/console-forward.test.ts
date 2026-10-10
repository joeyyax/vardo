import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));

import {
  applyConsoleForward,
  forwardHooks,
  meshIpFrom,
  parseForwardRules,
  planForward,
  pointConsoleForwardAt,
} from "@/lib/mesh/console-forward";
import { buildWgConfig } from "@/lib/mesh/wireguard";

const RULE_3 = "-A PREROUTING -i wg0 -p tcp -m tcp --dport 3000 -j DNAT --to-destination 10.88.0.3:3000";
const RULE_4 = "-A PREROUTING -i wg0 -p tcp -m tcp --dport 3000 -j DNAT --to-destination 10.88.0.4:3000";
const SAVE = (...rules: string[]) => ["-P PREROUTING ACCEPT", "-N DOCKER_OUTPUT", ...rules].join("\n");

type Call = string[];
const calls = (): Call[] => mockExec.mock.calls.map((c) => c[1] as string[]);

/** Answer `docker ...` calls by matching their arguments. */
function docker(handlers: Array<[(args: string[]) => boolean, string]>) {
  mockExec.mockImplementation(async (_file: string, args: string[]) => {
    for (const [match, stdout] of handlers) if (match(args)) return { stdout, stderr: "" };
    return { stdout: "", stderr: "" };
  });
}

const isIptablesList = (a: string[]) => a.includes("-S");
const isConfRead = (a: string[]) => a.some((x) => x.includes("grep -o"));
const isPs = (a: string[]) => a[0] === "ps";
const isInspect = (a: string[]) => a[0] === "inspect";

beforeEach(() => {
  mockExec.mockReset();
});

describe("forwardHooks", () => {
  it("DNATs the console port to the given address", () => {
    const { postUp, postDown } = forwardHooks("10.88.0.4", "3000");
    expect(postUp).toContain("-A PREROUTING -i wg0 -p tcp --dport 3000 -j DNAT --to-destination 10.88.0.4:3000");
    expect(postDown).toContain("-D PREROUTING -i wg0 -p tcp --dport 3000 -j DNAT --to-destination 10.88.0.4:3000");
  });

  it("rejects anything but an IPv4 address", () => {
    expect(() => forwardHooks("10.88.0.4; reboot", "3000")).toThrow();
  });

  it("is what buildWgConfig writes", () => {
    const key = "A".repeat(43) + "=";
    const conf = buildWgConfig(key, 51820, "10.99.0.1", [], "10.88.0.4");
    expect(conf).toContain("--to-destination 10.88.0.4:3000");
    expect(conf).not.toContain("10.88.0.3");
  });
});

describe("parseForwardRules", () => {
  it("finds console DNAT rules and their targets", () => {
    const rules = parseForwardRules(SAVE(RULE_3, "-A PREROUTING -i wg0 -p tcp -m tcp --dport 22 -j DNAT --to-destination 10.88.0.9:22"));
    expect(rules).toEqual([{ line: RULE_3, ip: "10.88.0.3" }]);
  });
});

describe("planForward", () => {
  it("adds the rule when there is none", () => {
    expect(planForward(SAVE(), "10.88.0.4")).toEqual([
      ["-t", "nat", "-A", "PREROUTING", "-i", "wg0", "-p", "tcp", "--dport", "3000", "-j", "DNAT", "--to-destination", "10.88.0.4:3000"],
    ]);
  });

  it("adds the new target before deleting the stale one", () => {
    const plan = planForward(SAVE(RULE_3), "10.88.0.4");
    expect(plan[0]).toContain("-A");
    expect(plan[1]).toEqual(["-t", "nat", "-D", "PREROUTING", "-i", "wg0", "-p", "tcp", "-m", "tcp", "--dport", "3000", "-j", "DNAT", "--to-destination", "10.88.0.3:3000"]);
    expect(plan).toHaveLength(2);
  });

  it("does nothing when the rule already points at the target", () => {
    expect(planForward(SAVE(RULE_4), "10.88.0.4")).toEqual([]);
  });

  it("drops duplicates of the target", () => {
    expect(planForward(SAVE(RULE_4, RULE_4), "10.88.0.4")).toHaveLength(1);
  });
});

describe("meshIpFrom", () => {
  it("picks the address on the gateway's /24", () => {
    expect(meshIpFrom(["172.18.0.5", "10.88.0.4", "172.19.0.2"], "10.88.0.2")).toBe("10.88.0.4");
  });

  it("is null off the mesh", () => {
    expect(meshIpFrom(["172.18.0.5"], "10.88.0.2")).toBeNull();
  });
});

describe("applyConsoleForward", () => {
  it("moves the live rule and rewrites wg0.conf for the next boot", async () => {
    docker([[isIptablesList, SAVE(RULE_3)]]);

    const replaced = await applyConsoleForward("10.88.0.4");

    expect(replaced).toEqual(["10.88.0.3"]);
    const iptables = calls().filter((a) => a.includes("iptables") && !a.includes("-S"));
    expect(iptables.map((a) => a.slice(2))).toEqual([
      ["iptables", "-t", "nat", "-A", "PREROUTING", "-i", "wg0", "-p", "tcp", "--dport", "3000", "-j", "DNAT", "--to-destination", "10.88.0.4:3000"],
      ["iptables", "-t", "nat", "-D", "PREROUTING", "-i", "wg0", "-p", "tcp", "-m", "tcp", "--dport", "3000", "-j", "DNAT", "--to-destination", "10.88.0.3:3000"],
    ]);
    const sed = calls().find((a) => a.some((x) => x.includes("sed -i")));
    expect(sed?.at(-1)).toContain("--to-destination 10.88.0.4:3000");
  });
});

describe("pointConsoleForwardAt", () => {
  it("points the forward at the new slot's console", async () => {
    docker([
      [isConfRead, "--to-destination 10.88.0.3:3000\n"],
      [isPs, "abc123\n"],
      [isInspect, "172.18.0.7 10.88.0.4 172.19.0.3 \n"],
      [isIptablesList, SAVE(RULE_3)],
    ]);
    const lines: string[] = [];

    await pointConsoleForwardAt("vardo-production-green", (l) => lines.push(l));

    expect(calls().find(isPs)).toContain("label=com.docker.compose.project=vardo-production-green");
    expect(calls().some((a) => a.includes("10.88.0.4:3000") && a.includes("-A"))).toBe(true);
    expect(lines).toEqual(["[deploy] Mesh console forward: 10.88.0.3 -> 10.88.0.4"]);
  });

  it("skips an instance without a mesh", async () => {
    docker([[isConfRead, "missing\n"]]);

    await pointConsoleForwardAt("vardo-production-green", () => {});

    expect(calls().some(isPs)).toBe(false);
  });

  it("never throws", async () => {
    mockExec.mockRejectedValue(new Error("No such container: vardo-wireguard"));
    const lines: string[] = [];

    await expect(pointConsoleForwardAt("vardo-production-green", (l) => lines.push(l))).resolves.toBeUndefined();
  });
});
