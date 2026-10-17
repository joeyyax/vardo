// The retired Traefik forward: whatever it left in the WireGuard container is removed once, and wg0.conf no longer carries it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));
vi.mock("@/lib/mesh/env", () => ({ isRunningInContainer: () => true }));

import { MESH_SUBNET } from "@/lib/mesh/constants";
import { resetRetireTraefikForward, retireTraefikForward } from "@/lib/mesh/retire-traefik";
import { buildWgConfig } from "@/lib/mesh/wireguard";

const PRIVATE = "a".repeat(43) + "=";
const calls = () => mockExec.mock.calls.map((c) => (c[1] as string[]).join(" "));
const rule = (ip: string, port: string) => `-A PREROUTING -s ${MESH_SUBNET} -i wg0 -p tcp -m tcp --dport ${port} -j DNAT --to-destination ${ip}:${port}`;

function docker(a: { rules?: string[]; post?: string[] }) {
  mockExec.mockImplementation(async (_file: string, args: string[]) => {
    const line = args.join(" ");
    if (line.includes("-S PREROUTING")) return { stdout: ["-P PREROUTING ACCEPT", ...(a.rules ?? [])].join("\n"), stderr: "" };
    if (line.includes("-S POSTROUTING")) return { stdout: ["-P POSTROUTING ACCEPT", ...(a.post ?? [])].join("\n"), stderr: "" };
    if (line.includes("echo $n")) return { stdout: "0\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => {
  mockExec.mockReset();
  resetRetireTraefikForward();
});

describe("retireTraefikForward", () => {
  it("removes the rules and the wg0.conf hooks the forward left, and leaves the console forward", async () => {
    docker({
      rules: [rule("172.18.0.5", "80"), rule("172.18.0.5", "443"), "-A PREROUTING -i wg0 -p tcp -m tcp --dport 3000 -j DNAT --to-destination 10.88.0.3:3000"],
      post: [`-A POSTROUTING -s ${MESH_SUBNET} -d 172.18.0.5/32 -p tcp -m tcp --dport 443 -j MASQUERADE`],
    });
    await retireTraefikForward();
    expect(calls().filter((c) => c.includes("-t nat -D PREROUTING"))).toHaveLength(2);
    expect(calls().some((c) => c.includes("-t nat -D POSTROUTING"))).toBe(true);
    expect(calls().some((c) => c.includes("--dport 3000") && c.includes("-D"))).toBe(false);
    expect(calls().some((c) => c.includes("sed -i") && c.includes("(80|443)"))).toBe(true);
  });

  it("runs once per process", async () => {
    docker({});
    await retireTraefikForward();
    mockExec.mockClear();
    await retireTraefikForward();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("tries again on the next pass after a failure", async () => {
    mockExec.mockRejectedValueOnce(new Error("permission denied"));
    await retireTraefikForward();
    docker({});
    await retireTraefikForward();
    expect(calls().some((c) => c.includes("-S PREROUTING"))).toBe(true);
  });
});

describe("buildWgConfig", () => {
  it("writes no route from the tunnel to Traefik", () => {
    expect(buildWgConfig(PRIVATE, 51820, "10.99.0.2", [], "10.88.0.3")).not.toMatch(/--dport (80|443)\b/);
  });
});
