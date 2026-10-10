import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFileAsync, mockExecFile } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExecFileAsync }));
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

import { ensureHubConfig, waitForInterface } from "@/lib/mesh/wireguard";

const PUB = "B".repeat(43) + "=";
const PRIV = "A".repeat(43) + "=";

const argsOf = () => mockExecFileAsync.mock.calls.map((c) => (c[1] as string[]).join(" "));

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: (err: null) => void) => {
    cb(null);
    return { stdin: { write: vi.fn(), end: vi.fn() } };
  });
});

describe("ensureHubConfig", () => {
  it("returns the running key without touching the container", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: `${PUB}\n`, stderr: "" });
    expect(await ensureHubConfig("10.99.0.1")).toBe(PUB);
    expect(argsOf()).toEqual(["exec vardo-wireguard sh -c wg show wg0 public-key"]);
  });

  it("restarts the container after a first config, so it boots with its default route", async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("no wg0"))
      .mockResolvedValueOnce({ stdout: `${PRIV}\n${PUB}\n`, stderr: "" })
      .mockResolvedValue({ stdout: "", stderr: "" });

    expect(await ensureHubConfig("10.99.0.1")).toBe(PUB);

    const calls = argsOf();
    expect(calls).toContain("restart vardo-wireguard");
    expect(calls.some((c) => c.includes("wg-quick up"))).toBe(false);
    expect(calls.at(-1)).toBe("exec vardo-wireguard wg show wg0 public-key");
  });
});

describe("waitForInterface", () => {
  it("polls until wg0 answers", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("not yet")).mockResolvedValue({ stdout: PUB, stderr: "" });
    await waitForInterface(3, 0);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("down"));
    await expect(waitForInterface(2, 0)).rejects.toThrow(/wg0/);
  });
});
