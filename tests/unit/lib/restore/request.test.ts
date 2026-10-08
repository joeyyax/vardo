import { describe, it, expect } from "vitest";
import { keyBodySchema, resolveMasterKey } from "@/lib/restore/request";

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);
const env = (k?: string) => ({ ENCRYPTION_MASTER_KEY: k }) as unknown as NodeJS.ProcessEnv;

describe("resolveMasterKey", () => {
  it("uses the key the browser sent", () => {
    expect(resolveMasterKey(KEY, env(OTHER))).toBe(KEY);
  });

  it("falls back to the key this host runs with", () => {
    expect(resolveMasterKey(undefined, env(KEY))).toBe(KEY);
  });

  it("is null when neither is a valid key", () => {
    expect(resolveMasterKey(undefined, env())).toBeNull();
    expect(resolveMasterKey(undefined, env("short"))).toBeNull();
  });

  it("does not fall back from a malformed key the browser sent", () => {
    expect(resolveMasterKey("short", env(KEY))).toBeNull();
  });
});

describe("keyBodySchema", () => {
  it("accepts a body without a master key", () => {
    expect(keyBodySchema.safeParse({ backupKey: "system/x" }).success).toBe(true);
  });

  it("still rejects a malformed master key", () => {
    expect(keyBodySchema.safeParse({ backupKey: "system/x", masterKey: "nope" }).success).toBe(false);
  });
});
