import { describe, expect, it } from "vitest";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";
import { parseCompose } from "@/lib/docker/compose-parse";
import { burstableReservationMb, describeMemory, effectiveProfile, memoryReservationFor } from "@/lib/resources/profile";

const COMPOSE = "services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n";
const formatDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

describe("effectiveProfile", () => {
  it("takes the app's, then the org's, then fixed", () => {
    expect(effectiveProfile("auto", "fixed")).toBe("auto");
    expect(effectiveProfile(null, "burstable")).toBe("burstable");
    expect(effectiveProfile(null, null)).toBe("fixed");
  });
});

describe("burstable memory", () => {
  it("reserves half the ceiling unless told otherwise, never more than the ceiling", () => {
    expect(burstableReservationMb(2048, null)).toBe(1024);
    expect(burstableReservationMb(2048, 512)).toBe(512);
    expect(burstableReservationMb(2048, 4096)).toBe(2048);
  });

  it("reserves nothing for fixed or auto", () => {
    expect(memoryReservationFor({ profile: "fixed", reservationMb: 512, limitMb: 2048 })).toBeNull();
    expect(memoryReservationFor({ profile: "auto", reservationMb: null, limitMb: 2048 })).toBeNull();
    expect(memoryReservationFor({ profile: "burstable", reservationMb: null, limitMb: 2048 })).toBe(1024);
  });

  it("writes the baseline as a reservation under the limit", () => {
    const overlay = buildVardoOverlay({
      fullCompose: parseCompose(COMPOSE),
      networkName: "vardo-network",
      memoryLimit: 2048,
      memoryReservation: 512,
      serviceConfig: { worker: { cpuLimit: null, memoryLimit: 1024, memoryReservation: null, gpuEnabled: false, priority: null } },
    });
    expect(overlay.services.web.deploy?.resources).toMatchObject({ limits: { memory: "2048M" }, reservations: { memory: "512M" } });
    expect(overlay.services.worker.deploy?.resources?.reservations).toBeUndefined();
  });
});

describe("describeMemory", () => {
  const base = {
    appProfile: "auto" as const,
    orgProfile: "fixed" as const,
    appLimitMb: 3072,
    reservationMb: null,
    tierDefaultMb: 2048,
    tier: "standard",
    containerLimitBytes: 3072 * 1024 * 1024,
    autotune: null,
    formatDate,
  };
  const changed = new Date("2026-10-10T09:50:00Z");

  it("says when and why Auto last raised it", () => {
    const autotune = { appliedMb: 3072, lastChangedAt: changed, lastRaisedAt: changed, lastReason: "after an OOM kill", haltedAt: null };
    expect(describeMemory({ ...base, autotune }).why).toBe("Auto-raised on Oct 10 after an OOM kill.");
  });

  it("says when Auto lowered it", () => {
    const autotune = { appliedMb: 3072, lastChangedAt: changed, lastRaisedAt: new Date("2026-09-01T00:00:00Z"), lastReason: "after 14 quiet days", haltedAt: null };
    expect(describeMemory({ ...base, autotune }).why).toBe("Auto-lowered on Oct 10 after 14 quiet days.");
  });

  it("names a limit someone set, and an inherited profile", () => {
    expect(describeMemory({ ...base, appProfile: "fixed" }).why).toBe("Set in Vardo.");
    expect(describeMemory({ ...base, appProfile: null, appLimitMb: null, containerLimitBytes: 2048 * 1024 * 1024 }).why).toBe(
      "The standard tier default. Profile: fixed (organization default).",
    );
    expect(describeMemory({ ...base, appProfile: null, appLimitMb: null, containerLimitBytes: 1024 * 1024 * 1024 }).why).toBe(
      "Set in compose. Profile: fixed (organization default).",
    );
  });

  it("explains a burstable baseline", () => {
    const burst = describeMemory({ ...base, appProfile: "burstable", appLimitMb: 2048, reservationMb: 512 });
    expect(burst).toMatchObject({ limitMb: 2048, reservationMb: 512 });
    expect(burst.why).toBe("Set in Vardo; 512 MB guaranteed, bursting to 2048 MB.");
  });

  it("says Auto hasn't acted yet", () => {
    expect(describeMemory({ ...base, appLimitMb: null, containerLimitBytes: 2048 * 1024 * 1024 }).why).toBe(
      "The standard tier default; auto hasn't changed it yet.",
    );
  });
});
