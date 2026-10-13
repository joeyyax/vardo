import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_PROBE_GUARD,
  DEFAULT_INSTANCE_PROBE_GUARD,
  appProbeGuardSchema,
  decoyPath,
  instanceProbeGuardSchema,
  normalizeAppProbeGuard,
  normalizeInstanceProbeGuard,
} from "@/lib/probe-guard/settings";

describe("app settings", () => {
  it("default to on with no exceptions", () => {
    expect(normalizeAppProbeGuard(null)).toEqual({ enabled: true, exceptions: [], rules: {}, blocks: [], templates: [], robotsTxt: false });
    expect(normalizeAppProbeGuard({ enabled: "yes" })).toEqual(DEFAULT_APP_PROBE_GUARD);
  });

  it("dedupe exceptions and refuse bad paths", () => {
    const ok = appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, exceptions: ["/a", "/a", " /b "] });
    expect(ok.success && ok.data.exceptions).toEqual(["/a", "/b"]);
    expect(appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, exceptions: ["/x`"] }).success).toBe(false);
  });
});

describe("app rules and blocks", () => {
  it("read a legacy row as the default", () => {
    expect(normalizeAppProbeGuard({ enabled: true, exceptions: [], wordpress: "auto", robotsTxt: false })).toEqual(DEFAULT_APP_PROBE_GUARD);
  });

  it("drop rule ids that no longer exist when reading, refuse them when saving", () => {
    expect(normalizeAppProbeGuard({ ...DEFAULT_APP_PROBE_GUARD, rules: { gone: true, dotenv: false } }).rules).toEqual({ dotenv: false });
    expect(appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, rules: { gone: true } }).success).toBe(false);
  });

  it("dedupe blocks and refuse a bad one", () => {
    const blocks = [{ kind: "prefix", value: "/old" }, { kind: "prefix", value: "/old" }, { kind: "exact", value: "/old" }];
    const ok = appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, blocks });
    expect(ok.success && ok.data.blocks).toHaveLength(2);
    expect(appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, blocks: [{ kind: "regex", value: ".*" }] }).success).toBe(false);
  });
});

describe("instance settings", () => {
  it("default to sharing off", () => {
    const s = normalizeInstanceProbeGuard(undefined);
    expect(s.shareBans).toBe(false);
    expect(s.threshold).toBe(5);
    expect(s.windowMinutes).toBe(10);
  });

  it("ignore retired settings in stored settings", () => {
    const s = normalizeInstanceProbeGuard({ ...DEFAULT_INSTANCE_PROBE_GUARD, threshold: 9, tarpitMs: 2000, humor: true });
    expect(s.threshold).toBe(9);
    expect("tarpitMs" in s).toBe(false);
    expect("humor" in s).toBe(false);
  });

  it("refuse a first ban longer than the longest", () => {
    expect(instanceProbeGuardSchema.safeParse({ ...DEFAULT_INSTANCE_PROBE_GUARD, banMinutes: 600, maxBanHours: 1 }).success).toBe(false);
  });

  it("serve the decoy from the first trap directory", () => {
    expect(decoyPath(DEFAULT_INSTANCE_PROBE_GUARD)).toBe("/admin-backup/.env");
    expect(decoyPath({ ...DEFAULT_INSTANCE_PROBE_GUARD, traps: { ...DEFAULT_INSTANCE_PROBE_GUARD.traps, decoy: false } })).toBeNull();
    expect(decoyPath({ ...DEFAULT_INSTANCE_PROBE_GUARD, traps: { enabled: true, decoy: true, paths: ["/x.sql"] } })).toBeNull();
  });
});
