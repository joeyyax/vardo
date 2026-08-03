// ---------------------------------------------------------------------------
// Traefik addresses the old slot by IP and only reconciles after the container
// is gone, so a request can be sent to a dead address. The swap has to route
// away from the old slot first and hand routing back only once it has gone.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { canPinCutover, drainThenStop } from "@/lib/docker/deploy-steps/swap";
import type { CutoverGuard } from "@/lib/docker/traefik-cutover";

function recorder() {
  const calls: string[] = [];
  const guard: CutoverGuard = {
    pinned: true,
    release: async () => {
      calls.push("release");
    },
  };
  return {
    calls,
    drain: async () => {
      calls.push("drain");
      return guard;
    },
    stop: async () => {
      calls.push("stop");
    },
  };
}

describe("drainThenStop", () => {
  it("routes away from the old slot before stopping it", async () => {
    const r = recorder();
    await drainThenStop(r.drain, r.stop);
    expect(r.calls).toEqual(["drain", "stop", "release"]);
  });

  it("hands routing back even when the stop fails", async () => {
    const r = recorder();
    await expect(
      drainThenStop(r.drain, async () => {
        r.calls.push("stop");
        throw new Error("docker unreachable");
      }),
    ).rejects.toThrow("docker unreachable");
    expect(r.calls).toEqual(["drain", "stop", "release"]);
  });

  it("does not stop the old slot when routing away threw", async () => {
    const r = recorder();
    await expect(
      drainThenStop(async () => {
        throw new Error("traefik unreachable");
      }, r.stop),
    ).rejects.toThrow("traefik unreachable");
    expect(r.calls).toEqual([]);
  });
});

describe("canPinCutover", () => {
  it("pins when both slots are up, so there is a proven backend to move to", () => {
    expect(canPinCutover(true, false)).toBe(true);
  });

  it("does not pin when the old slot was already stopped before the new one started", () => {
    expect(canPinCutover(false, false)).toBe(false);
  });

  it("does not pin the deferred self-deploy — the stop kills the process that would unpin", () => {
    expect(canPinCutover(true, true)).toBe(false);
  });
});
