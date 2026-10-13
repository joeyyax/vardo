import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_PROBE_GUARD,
  DEFAULT_INSTANCE_PROBE_GUARD,
  appProbeGuardSchema,
  decoyPath,
  instanceProbeGuardPartialSchema,
  instanceProbeGuardSchema,
  mergeInstanceProbeGuard,
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

describe("mergeInstanceProbeGuard", () => {
  const stored = {
    ...DEFAULT_INSTANCE_PROBE_GUARD,
    threshold: 7,
    traps: { enabled: false, paths: ["/old/"], decoy: false },
    exceptions: ["/kept"],
    blocks: [{ kind: "prefix" as const, value: "/kept-block" }],
    securityContact: "old@example.com",
  };

  it("keeps other fields when only one top-level field is patched", () => {
    const merged = mergeInstanceProbeGuard(stored, { threshold: 11 });
    expect(merged.threshold).toBe(11);
    expect(merged.traps).toEqual(stored.traps);
    expect(merged.exceptions).toEqual(stored.exceptions);
    expect(merged.blocks).toEqual(stored.blocks);
    expect(merged.securityContact).toBe(stored.securityContact);
  });

  it("merges traps one level deep", () => {
    const merged = mergeInstanceProbeGuard(stored, { traps: { enabled: true, paths: ["/new/"] } });
    expect(merged.traps).toEqual({ enabled: true, paths: ["/new/"], decoy: false });
  });

  it("replaces exceptions and blocks wholesale", () => {
    const merged = mergeInstanceProbeGuard(stored, { exceptions: ["/new-ex"], blocks: [{ kind: "exact", value: "/new-block" }] });
    expect(merged.exceptions).toEqual(["/new-ex"]);
    expect(merged.blocks).toEqual([{ kind: "exact", value: "/new-block" }]);
  });

  it("rejects unknown top-level and traps fields", () => {
    expect(() => mergeInstanceProbeGuard(stored, { unknown: true } as never)).toThrow(/Unknown field/);
    expect(() => mergeInstanceProbeGuard(stored, { traps: { unknown: true } as never })).toThrow(/Unknown traps field/);
  });

  it("partial schema refuses values outside the full schema's range", () => {
    const ok = instanceProbeGuardPartialSchema.safeParse({ threshold: 2 });
    expect(ok.success).toBe(true);
    const bad = instanceProbeGuardPartialSchema.safeParse({ threshold: 1 });
    expect(bad.success).toBe(false);
  });

  it("refuses a merge that makes the full schema invalid", () => {
    const stored = { ...DEFAULT_INSTANCE_PROBE_GUARD, maxBanHours: 1 };
    const merged = mergeInstanceProbeGuard(stored, { banMinutes: 600 });
    const final = instanceProbeGuardSchema.safeParse(merged);
    expect(final.success).toBe(false);
  });
});
