// Registry credentials are stored encrypted; the pull path reads plaintext.

import { describe, it, expect, vi } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "e".repeat(64);

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { query: { systemSettings: { findFirst } } } }));

const { encryptSystem } = await import("@/lib/crypto/encrypt");
const { getRegistryCredentials, invalidateRegistryCredentials } = await import(
  "@/lib/docker/image-updates/registry"
);
const { invalidateSettingsCache } = await import("@/lib/system-settings");

describe("getRegistryCredentials", () => {
  it("decrypts the stored setting", async () => {
    const stored = { "ghcr.io": { username: "u", password: "ghp_token" } };
    findFirst.mockResolvedValue({ key: "registry_credentials", value: encryptSystem(JSON.stringify(stored)) });
    invalidateSettingsCache();
    invalidateRegistryCredentials();

    expect(await getRegistryCredentials()).toMatchObject(stored);
  });
});
