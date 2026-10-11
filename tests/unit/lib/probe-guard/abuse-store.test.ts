import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, string>();

vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async (key: string) => stored.get(key) ?? null),
  setSystemSetting: vi.fn(async (key: string, value: string) => {
    const { encryptSystem } = await import("@/lib/crypto/encrypt");
    stored.set(`${key}:at-rest`, encryptSystem(value));
    stored.set(key, value);
  }),
}));

import { ABUSE_KEY_KEY, getAbuseApiKey, getAbuseSettings, maskApiKey, setAbuseApiKey } from "@/lib/probe-guard/abuse-store";
import { DEFAULT_ABUSE_SETTINGS, abuseSettingsBodySchema } from "@/lib/probe-guard/abuse-settings";
import { maskDisplay } from "@/lib/mask-secrets";

const KEY = "0123456789abcdef".repeat(5);

beforeEach(() => {
  stored.clear();
  process.env.ENCRYPTION_MASTER_KEY = "f".repeat(64);
});

describe("AbuseIPDB key storage", () => {
  it("stores the key encrypted at rest", async () => {
    await setAbuseApiKey(KEY);
    const atRest = stored.get(`${ABUSE_KEY_KEY}:at-rest`)!;
    expect(atRest).not.toContain(KEY);
    expect(atRest).not.toContain(KEY.slice(0, 16));
    const { decryptSystemOrFallback } = await import("@/lib/crypto/encrypt");
    expect(decryptSystemOrFallback(atRest).content).toBe(KEY);
    expect(await getAbuseApiKey()).toBe(KEY);
  });

  it("shows only the last four characters", () => {
    const masked = maskApiKey(KEY)!;
    expect(masked).not.toContain(KEY.slice(0, -4));
    expect(maskDisplay(masked)).toBe(`••••${KEY.slice(-4)}`);
    expect(maskApiKey(null)).toBeNull();
  });

  it("removes the key when cleared", async () => {
    await setAbuseApiKey(KEY);
    await setAbuseApiKey(null);
    expect(await getAbuseApiKey()).toBeNull();
  });

  it("starts with every toggle off", async () => {
    expect(await getAbuseSettings()).toEqual(DEFAULT_ABUSE_SETTINGS);
  });

  it("refuses a masked value as a new key", () => {
    expect(abuseSettingsBodySchema.safeParse({ settings: DEFAULT_ABUSE_SETTINGS, apiKey: maskApiKey(KEY) }).success).toBe(false);
    expect(abuseSettingsBodySchema.safeParse({ settings: DEFAULT_ABUSE_SETTINGS }).success).toBe(true);
  });
});
