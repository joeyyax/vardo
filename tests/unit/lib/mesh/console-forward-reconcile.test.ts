import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec, answering } = vi.hoisted(() => ({ mockExec: vi.fn(), answering: new Set<string>() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));
vi.mock("@/lib/mesh/env", () => ({ isRunningInContainer: () => true }));
vi.mock("node:os", () => ({
  networkInterfaces: () => ({
    eth0: [{ family: "IPv4", address: "172.18.0.7" }],
    eth1: [{ family: "IPv4", address: "10.88.0.4" }],
  }),
}));
vi.mock("node:net", () => ({
  connect: ({ host }: { host: string }) => {
    const socket = Object.assign(new EventEmitter(), { destroy: () => {}, setTimeout: () => {} });
    queueMicrotask(() => socket.emit(answering.has(host) ? "connect" : "error", new Error("EHOSTUNREACH")));
    return socket;
  },
}));

import { checkConsoleForward, reconcileConsoleForward } from "@/lib/mesh/console-forward";

const rule = (ip: string) => `-A PREROUTING -i wg0 -p tcp -m tcp --dport 3000 -j DNAT --to-destination ${ip}:3000`;

/** A fake vardo-wireguard: one DNAT rule list and one wg0.conf target. */
function wireguard(state: { rules: string[]; conf: string | null }) {
  mockExec.mockImplementation(async (_file: string, args: string[]) => {
    const cmd = args.slice(2);
    if (cmd[0] === "iptables" && cmd.includes("-S")) return { stdout: state.rules.join("\n") };
    if (cmd[0] === "iptables") {
      const target = cmd.at(-1)!;
      if (cmd.includes("-A")) state.rules.push(rule(target.split(":")[0]));
      if (cmd.includes("-D")) state.rules = state.rules.filter((r) => !r.endsWith(target));
      return { stdout: "" };
    }
    const script = cmd.at(-1)!;
    if (script.includes("grep -o")) {
      return { stdout: state.conf === null ? "missing\n" : `--to-destination ${state.conf}:3000\n` };
    }
    const sed = script.match(/--to-destination ([\d.]+):3000\/g/);
    if (sed && state.conf !== null) state.conf = sed[1];
    return { stdout: "" };
  });
  return state;
}

beforeEach(() => {
  mockExec.mockReset();
  answering.clear();
});

describe("checkConsoleForward", () => {
  it("is unconfigured without wg0.conf", async () => {
    wireguard({ rules: [], conf: null });
    expect(await checkConsoleForward()).toEqual({ state: "unconfigured" });
  });

  it("reports a target that doesn't answer", async () => {
    wireguard({ rules: [rule("10.88.0.3")], conf: "10.88.0.3" });
    expect(await checkConsoleForward()).toMatchObject({ state: "broken", target: "10.88.0.3", answers: false });
  });
});

describe("reconcileConsoleForward", () => {
  it("moves a dead target to this console, live and on disk", async () => {
    const state = wireguard({ rules: [rule("10.88.0.3")], conf: "10.88.0.3" });
    answering.add("10.88.0.4");

    const result = await reconcileConsoleForward();

    expect(result).toEqual({ state: "ok", target: "10.88.0.4" });
    expect(state.rules).toEqual([rule("10.88.0.4")]);
    expect(state.conf).toBe("10.88.0.4");
  });

  it("adds the rule a WireGuard restart left out", async () => {
    const state = wireguard({ rules: [], conf: "10.88.0.3" });
    answering.add("10.88.0.4");

    await reconcileConsoleForward();

    expect(state.rules).toEqual([rule("10.88.0.4")]);
  });

  it("keeps a live target and syncs wg0.conf to it", async () => {
    const state = wireguard({ rules: [rule("10.88.0.5")], conf: "10.88.0.3" });
    answering.add("10.88.0.5");

    const result = await reconcileConsoleForward();

    expect(result).toEqual({ state: "ok", target: "10.88.0.5" });
    expect(state.rules).toEqual([rule("10.88.0.5")]);
    expect(state.conf).toBe("10.88.0.5");
  });

  it("leaves a healthy forward alone", async () => {
    wireguard({ rules: [rule("10.88.0.4")], conf: "10.88.0.4" });
    answering.add("10.88.0.4");

    expect(await reconcileConsoleForward()).toEqual({ state: "ok", target: "10.88.0.4" });
    expect(mockExec.mock.calls.some((c) => (c[1] as string[]).some((a) => a.includes("sed -i")))).toBe(false);
  });
});
