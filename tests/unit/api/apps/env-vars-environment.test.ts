import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

// The Variables tab edits a non-default environment's own env. Production's
// apps.env_content stays as it is.

const { state, appUpdates, saveMock } = vi.hoisted(() => ({
  state: {
    env: undefined as { id: string; isDefault: boolean } | undefined,
    own: null as string | null,
    appEnv: null as string | null,
  },
  appUpdates: [] as Record<string, unknown>[],
  saveMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      environments: { findFirst: vi.fn(async () => state.env) },
      apps: { findFirst: vi.fn(async () => ({ envContent: state.appEnv })) },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        appUpdates.push(values);
        return { where: async () => undefined };
      },
    }),
  },
}));
vi.mock("@/lib/docker/environment-env", () => ({
  loadEnvironmentEnv: vi.fn(async () => state.own),
  saveEnvironmentEnv: saveMock,
}));
vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn().mockResolvedValue({ session: { user: { id: "u1" } } }),
  verifyAppAccess: vi.fn().mockResolvedValue({ id: "app-1" }),
}));
const recordActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/api/system-managed", () => ({ refuseSystemManaged: () => null }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: never[]) => unknown) => handler,
}));

import { GET, PUT } from "@/app/api/v1/organizations/[orgId]/apps/[appId]/env-vars/route";
import { encrypt, decrypt } from "@/lib/crypto/encrypt";

const params = { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) };
const get = (query: string) =>
  GET(new NextRequest(`http://localhost/api/v1/organizations/org-1/apps/app-1/env-vars?reveal=true${query}`), params);
const put = (body: Record<string, unknown>) =>
  PUT(
    new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1/env-vars", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  appUpdates.length = 0;
  state.env = { id: "env-pr-7", isDefault: false };
  state.own = null;
  state.appEnv = encrypt("A=prod", "org-1");
});

describe("env-vars for an environment", () => {
  it("returns the environment's own env", async () => {
    state.own = encrypt("A=preview", "org-1");

    const res = await get("&environmentId=env-pr-7");

    expect(await res.json()).toEqual({ content: "A=preview" });
  });

  it("records who revealed the env", async () => {
    await get("&environmentId=env-pr-7");

    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "app.env_revealed", appId: "app-1", userId: "u1" }),
    );
  });

  it("records nothing for the masked env", async () => {
    await GET(new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1/env-vars"), params);

    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("returns the app's env marked inherited when the environment has none", async () => {
    const res = await get("&environmentId=env-pr-7");

    expect(await res.json()).toEqual({ content: "A=prod", inherited: true });
  });

  it("refuses an environment of another app", async () => {
    state.env = undefined;

    const res = await get("&environmentId=env-other");

    expect(res.status).toBe(404);
  });

  it("saves to the environment and leaves the app's env alone", async () => {
    await put({ content: "A=edited", environmentId: "env-pr-7" });

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(decrypt(saveMock.mock.calls[0][1], "org-1")).toBe("A=edited");
    expect(appUpdates).toEqual([]);
  });

  it("saves to the app without an environment", async () => {
    await put({ content: "A=edited" });

    expect(saveMock).not.toHaveBeenCalled();
    expect(decrypt(appUpdates[0].envContent as string, "org-1")).toBe("A=edited");
  });
});
