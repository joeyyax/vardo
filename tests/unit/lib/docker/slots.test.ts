import { describe, it, expect, vi } from "vitest";
import { detectActiveSlot, type SlotProbes } from "@/lib/docker/slots";

const APP_DIR = "/opt/vardo/apps/ollama/production";
const PREFIX = "ollama-production";

/**
 * Build a probe set. By default everything is "absent": symlink and legacy
 * file reject (ENOENT), and no slot is running. Override per test.
 */
function probes(overrides: Partial<SlotProbes> = {}): SlotProbes {
  return {
    readSymlink: vi.fn(() => Promise.reject(new Error("ENOENT"))),
    readActiveFile: vi.fn(() => Promise.reject(new Error("ENOENT"))),
    isSlotRunning: vi.fn(() => Promise.resolve(false)),
    ...overrides,
  };
}

describe("detectActiveSlot", () => {
  it("returns the slot from the current symlink (authoritative)", async () => {
    expect(
      await detectActiveSlot(APP_DIR, PREFIX, probes({ readSymlink: () => Promise.resolve("green\n") })),
    ).toBe("green");
  });

  it("symlink wins over a running slot and the legacy file", async () => {
    const p = probes({
      readSymlink: () => Promise.resolve("green"),
      isSlotRunning: vi.fn(() => Promise.resolve(true)), // blue would match first
      readActiveFile: () => Promise.resolve("blue"),
    });
    expect(await detectActiveSlot(APP_DIR, PREFIX, p)).toBe("green");
    // Never falls through to Docker when the symlink resolves.
    expect(p.isSlotRunning).not.toHaveBeenCalled();
  });

  it("falls back to the running slot when there is no symlink", async () => {
    const p = probes({
      isSlotRunning: vi.fn((project: string) => Promise.resolve(project === `${PREFIX}-green`)),
    });
    expect(await detectActiveSlot(APP_DIR, PREFIX, p)).toBe("green");
    expect(p.isSlotRunning).toHaveBeenCalledWith(`${PREFIX}-blue`);
    expect(p.isSlotRunning).toHaveBeenCalledWith(`${PREFIX}-green`);
  });

  it("falls back to the running slot when there is no symlink — blue slot", async () => {
    const p = probes({
      isSlotRunning: vi.fn((project: string) => Promise.resolve(project === `${PREFIX}-blue`)),
    });
    expect(await detectActiveSlot(APP_DIR, PREFIX, p)).toBe("blue");
    expect(p.isSlotRunning).toHaveBeenCalledWith(`${PREFIX}-blue`);
    // green should not be needed since blue matched first
    expect(p.isSlotRunning).not.toHaveBeenCalledWith(`${PREFIX}-green`);
  });

  it("running slot wins over a drifted legacy file", async () => {
    // The real port holder is what must be torn down, even if .active-slot lies.
    const p = probes({
      isSlotRunning: (project: string) => Promise.resolve(project === `${PREFIX}-blue`),
      readActiveFile: () => Promise.resolve("green"),
    });
    expect(await detectActiveSlot(APP_DIR, PREFIX, p)).toBe("blue");
  });

  it("falls back to the legacy .active-slot file when nothing is running", async () => {
    expect(
      await detectActiveSlot(APP_DIR, PREFIX, probes({ readActiveFile: () => Promise.resolve("green") })),
    ).toBe("green");
  });

  it("returns null on a genuine first deploy (nothing detectable)", async () => {
    expect(await detectActiveSlot(APP_DIR, PREFIX, probes())).toBeNull();
  });

  it("ignores invalid symlink/file contents and keeps resolving", async () => {
    const p = probes({
      readSymlink: () => Promise.resolve("local"), // not a blue/green slot
      readActiveFile: () => Promise.resolve("garbage"),
    });
    expect(await detectActiveSlot(APP_DIR, PREFIX, p)).toBeNull();
  });

  it("survives a Docker probe error and still consults the legacy file", async () => {
    const p = probes({
      isSlotRunning: () => Promise.reject(new Error("docker daemon unreachable")),
      readActiveFile: () => Promise.resolve("blue"),
    });
    expect(await detectActiveSlot(APP_DIR, PREFIX, p)).toBe("blue");
  });
});
