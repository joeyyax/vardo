import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Build registry settings: the password is write-only and kept when left blank.

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => ({}) }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: async (key: string) => store.get(key) || null,
  setSystemSetting: async (key: string, value: string) => void store.set(key, value),
}));

import { GET, POST } from "@/app/api/v1/admin/build-registry/route";

type Handler = (r?: NextRequest) => Promise<Response>;

const post = (body: unknown) =>
  (POST as unknown as Handler)(
    new NextRequest("http://localhost/api/v1/admin/build-registry", { method: "POST", body: JSON.stringify(body) }),
  );
const get = async () => (await (GET as unknown as Handler)()).json();
const stored = () => JSON.parse(store.get("build_registry") || "null");

beforeEach(() => store.clear());

describe("/api/v1/admin/build-registry", () => {
  it("is off until set", async () => {
    expect(await get()).toEqual({ configured: true, enabled: false, url: "", username: "", hasPassword: false });
  });

  it("saves the registry and never returns the password", async () => {
    expect((await post({ enabled: true, url: "ghcr.io/joeyyax", username: "joey", password: "tok" })).status).toBe(200);
    expect(stored()).toEqual({ url: "ghcr.io/joeyyax", username: "joey", password: "tok" });
    const body = await get();
    expect(body).toEqual({ configured: true, enabled: true, url: "ghcr.io/joeyyax", username: "joey", hasPassword: true });
  });

  it("keeps the stored password when left blank for the same user and host only", async () => {
    await post({ enabled: true, url: "ghcr.io/joeyyax", username: "joey", password: "tok" });
    await post({ enabled: true, url: "ghcr.io/other", username: "joey" });
    expect(stored().password).toBe("tok");
    expect((await post({ enabled: true, url: "ghcr.io/other", username: "someone" })).status).toBe(400);
    expect((await post({ enabled: true, url: "evil.example.com/x", username: "joey" })).status).toBe(400);
    expect(stored().password).toBe("tok");
  });

  it("refuses a URL Docker can't use as a prefix", async () => {
    expect((await post({ enabled: true, url: "joeyyax" })).status).toBe(400);
  });

  it("turns off", async () => {
    await post({ enabled: true, url: "localhost:5001" });
    await post({ enabled: false });
    expect((await get()).enabled).toBe(false);
  });
});
