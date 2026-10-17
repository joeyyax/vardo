// An instance that ran mesh SSH loses its forward, container and volume once, and keeps anything that isn't Vardo's.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as string[][],
  prerouting: "",
  container: null as string | null,
  wgDown: false,
}));

vi.mock("@/lib/mesh/env", () => ({ isRunningInContainer: () => true }));
vi.mock("@/lib/utils/exec", () => ({
  execFileAsync: async (_cmd: string, args: string[]) => {
    state.calls.push(args);
    if (args[0] === "exec" && state.wgDown) throw Object.assign(new Error("exit 1"), { stderr: "Error response from daemon: No such container: vardo-wireguard" });
    if (args[0] === "exec" && args.includes("-S")) return { stdout: state.prerouting };
    if (args[0] === "exec" && args.includes("sh") && args.at(-1)!.includes("while")) return { stdout: "1\n" };
    if (args[0] === "exec") return { stdout: "" };
    if (args[0] === "inspect") {
      if (state.container === null) throw Object.assign(new Error("exit 1"), { stderr: "Error: No such object: vardo-mesh-ssh" });
      return { stdout: `${state.container}\n` };
    }
    return { stdout: "" };
  },
}));

const { planSshForwardRemoval, resetRetireMeshSsh, retireMeshSsh } = await import("@/lib/mesh/retire-ssh");

const SSH_RULE = "-A PREROUTING -i wg0 -p tcp -m tcp --dport 22 -j DNAT --to-destination 10.88.0.9:22";
const CONSOLE_RULE = "-A PREROUTING -i wg0 -p tcp -m tcp --dport 3000 -j DNAT --to-destination 10.88.0.3:3000";

beforeEach(() => {
  resetRetireMeshSsh();
  state.calls.length = 0;
  state.prerouting = [CONSOLE_RULE, SSH_RULE].join("\n");
  state.container = "mesh-ssh|vardo_mesh_ssh";
  state.wgDown = false;
});

const docker = (first: string) => state.calls.filter((c) => c[0] === first);

describe("planSshForwardRemoval", () => {
  it("deletes only the SSH port's DNAT rules", () => {
    expect(planSshForwardRemoval(state.prerouting)).toEqual([["-t", "nat", "-D", ...SSH_RULE.split(" ").slice(1)]]);
  });
});

describe("retireMeshSsh", () => {
  it("removes the forward, wg0.conf hooks, container and volume, then stops", async () => {
    await retireMeshSsh();
    const exec = docker("exec").map((c) => c.slice(2).join(" "));
    expect(exec).toContain(`iptables -t nat -D ${SSH_RULE.split(" ").slice(1).join(" ")}`);
    expect(exec.some((c) => c.includes("sed -i") && c.includes("--dport 22 -j DNAT"))).toBe(true);
    expect(docker("rm")).toEqual([["rm", "-f", "vardo-mesh-ssh"]]);
    expect(docker("volume")).toEqual([["volume", "rm", "vardo_mesh_ssh"]]);

    state.calls.length = 0;
    await retireMeshSsh();
    expect(state.calls).toEqual([]);
  });

  it("leaves a container of that name that isn't Vardo's service", async () => {
    state.container = "something-else|";
    await retireMeshSsh();
    expect(docker("rm")).toEqual([]);
    expect(docker("volume")).toEqual([]);
  });

  it("still removes the container when WireGuard isn't running", async () => {
    state.wgDown = true;
    await retireMeshSsh();
    expect(docker("rm")).toEqual([["rm", "-f", "vardo-mesh-ssh"]]);
  });

  it("does nothing more when there's nothing left", async () => {
    state.container = null;
    state.prerouting = CONSOLE_RULE;
    await retireMeshSsh();
    expect(docker("rm")).toEqual([]);
    expect(docker("exec").some((c) => c.includes("-D"))).toBe(false);
  });
});
