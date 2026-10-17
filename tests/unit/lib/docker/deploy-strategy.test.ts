import { describe, it, expect } from "vitest";
import { crossSlotMounts, lockConflictHint, lockErrorLine } from "@/lib/docker/deploy-strategy";
import type { ComposeFile, ComposeService } from "@/lib/docker/compose-types";

describe("lockErrorLine", () => {
  it.each([
    "IO error: lock /server/volume/scrypted.db/LOCK: Resource temporarily unavailable",
    "OpenError: LEVEL_LOCKED",
    "sqlite3.OperationalError: database is locked",
    "fatal: could not acquire lock on /config/.storage",
    "Data directory is locked by another process",
  ])("finds %s", (line) => {
    expect(lockErrorLine(`starting\n${line}\nexiting`)).toBe(line);
  });

  it.each([
    "Unlocked the vault",
    "Lockfile written",
    "Error: Resource temporarily unavailable (EAGAIN) reading socket",
  ])("ignores %s", (line) => {
    expect(lockErrorLine(line)).toBeNull();
  });

  it("caps a long line", () => {
    expect(lockErrorLine(`database is locked ${"x".repeat(500)}`)!.length).toBeLessThanOrEqual(201);
  });
});

describe("crossSlotMounts", () => {
  const compose = { services: {}, volumes: { data: {} } } as unknown as ComposeFile;

  it("counts absolute binds and declared volumes, not slot-relative paths", () => {
    const slotted = {
      web: { volumes: ["/mnt/state:/state", "data:/data", "./config:/config", "/var/run/docker.sock:/var/run/docker.sock:ro"] },
    } as unknown as Record<string, ComposeService>;
    expect(crossSlotMounts(compose, slotted)).toEqual(["/mnt/state", "data", "/var/run/docker.sock"]);
  });
});

describe("lockConflictHint", () => {
  const compose = { services: {} } as unknown as ComposeFile;
  const slotted = { app: { volumes: ["/mnt/app:/data"] } } as unknown as Record<string, ComposeService>;
  const base = { logs: "database is locked", compose, slotted, overlapped: true, activeSlot: "blue", newSlot: "green" };

  it("names the shared data and the setting", () => {
    expect(lockConflictHint(base)).toMatch(/\/mnt\/app[\s\S]*Stop first/);
  });

  it("needs the slots to have overlapped", () => {
    expect(lockConflictHint({ ...base, overlapped: false })).toBeNull();
  });

  it("needs data both slots open", () => {
    const own = { app: { volumes: ["./data:/data"] } } as unknown as Record<string, ComposeService>;
    expect(lockConflictHint({ ...base, slotted: own })).toBeNull();
  });
});
