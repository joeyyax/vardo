import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_PROBE_GUARD,
  DEFAULT_INSTANCE_PROBE_GUARD,
  appProbeGuardSchema,
  decoyPath,
  detectWordPress,
  instanceProbeGuardSchema,
  isWordPress,
  normalizeAppProbeGuard,
  normalizeInstanceProbeGuard,
} from "@/lib/probe-guard/settings";

describe("app settings", () => {
  it("default to on with no exceptions", () => {
    expect(normalizeAppProbeGuard(null)).toEqual({ enabled: true, exceptions: [], wordpress: "auto", robotsTxt: false });
    expect(normalizeAppProbeGuard({ enabled: "yes" })).toEqual(DEFAULT_APP_PROBE_GUARD);
  });

  it("dedupe exceptions and refuse bad paths", () => {
    const ok = appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, exceptions: ["/a", "/a", " /b "] });
    expect(ok.success && ok.data.exceptions).toEqual(["/a", "/b"]);
    expect(appProbeGuardSchema.safeParse({ ...DEFAULT_APP_PROBE_GUARD, exceptions: ["/x`"] }).success).toBe(false);
  });
});

describe("instance settings", () => {
  it("default to humor on, sharing off", () => {
    const s = normalizeInstanceProbeGuard(undefined);
    expect(s.humor).toBe(true);
    expect(s.shareBans).toBe(false);
    expect(s.threshold).toBe(5);
    expect(s.windowMinutes).toBe(10);
  });

  it("ignore the retired delay setting in stored settings", () => {
    const s = normalizeInstanceProbeGuard({ ...DEFAULT_INSTANCE_PROBE_GUARD, threshold: 9, tarpitMs: 2000 });
    expect(s.threshold).toBe(9);
    expect("tarpitMs" in s).toBe(false);
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

describe("detectWordPress", () => {
  it("reads the image, template and compose file", () => {
    expect(detectWordPress({ imageName: "wordpress:6-php8.3" })).toBe(true);
    expect(detectWordPress({ imageName: "bitnami/wordpress" })).toBe(true);
    expect(detectWordPress({ templateName: "wordpress" })).toBe(true);
    expect(detectWordPress({ composeContent: "services:\n  wp:\n    image: wordpress:latest\n" })).toBe(true);
    expect(detectWordPress({ childImages: [null, "docker.io/library/wordpress@sha256:abc"] })).toBe(true);
  });

  it("ignores lookalikes", () => {
    expect(detectWordPress({ imageName: "ghost:5" })).toBe(false);
    expect(detectWordPress({ imageName: "acme/wordpress-exporter" })).toBe(false);
    expect(detectWordPress({ composeContent: "# migrated from wordpress\nservices:\n  web:\n    image: nginx\n" })).toBe(false);
  });

  it("lets the setting override detection", () => {
    expect(isWordPress({ ...DEFAULT_APP_PROBE_GUARD, wordpress: "off" }, true)).toBe(false);
    expect(isWordPress({ ...DEFAULT_APP_PROBE_GUARD, wordpress: "on" }, false)).toBe(true);
    expect(isWordPress(DEFAULT_APP_PROBE_GUARD, true)).toBe(true);
  });
});
