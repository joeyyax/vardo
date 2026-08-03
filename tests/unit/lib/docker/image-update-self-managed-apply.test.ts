// ---------------------------------------------------------------------------
// The apply path refuses Vardo-pinned images whatever the UI does.
//
// The endpoint is public API, so the refusal is enforced here rather than left
// to the surfaces that stopped offering the pin.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveUpdatableApp, getAppUpdateStatus, setServiceImageTag, dbMock } = vi.hoisted(() => ({
  resolveUpdatableApp: vi.fn(),
  getAppUpdateStatus: vi.fn(),
  setServiceImageTag: vi.fn(),
  dbMock: {
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
  },
}));

vi.mock("@/lib/docker/image-updates/resolve-app", () => ({ resolveUpdatableApp }));
vi.mock("@/lib/docker/image-updates/status", () => ({ getAppUpdateStatus }));
vi.mock("@/lib/docker/image-updates/apply", () => ({
  setServiceImageTag,
  setImageRefTag: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));

import { applyImageUpdate } from "@/lib/docker/image-updates/apply-update";

const request = { orgId: "org-1", appId: "app-1", userId: "user-1", tag: "17.4" };

function app(over: Record<string, unknown>) {
  return {
    id: "app-1",
    name: "loki",
    displayName: "Loki",
    deployType: "compose",
    imageName: null,
    composeContent: "services:\n  loki:\n    image: grafana/loki:3.4\n",
    composeService: null,
    composeOwnerId: "app-1",
    isSystemManaged: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAppUpdateStatus.mockResolvedValue({ services: [], ignored: [], blockedMigration: null });
});

describe("applyImageUpdate — Vardo-managed backstop", () => {
  it("refuses a core service", async () => {
    resolveUpdatableApp.mockResolvedValue(app({}));

    const outcome = await applyImageUpdate({ ...request, service: "loki" });

    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(setServiceImageTag).not.toHaveBeenCalled();
  });

  it("refuses a decomposed core service's child row", async () => {
    resolveUpdatableApp.mockResolvedValue(
      app({ name: "glitchtip-postgres", composeService: "postgres", composeOwnerId: "app-parent" }),
    );

    const outcome = await applyImageUpdate({ ...request, service: "postgres" });

    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(setServiceImageTag).not.toHaveBeenCalled();
  });

  it("refuses a core service whose flag was never backfilled", async () => {
    resolveUpdatableApp.mockResolvedValue(app({ isSystemManaged: false }));

    const outcome = await applyImageUpdate({ ...request, service: "loki" });

    expect(outcome).toMatchObject({ ok: false, status: 403 });
  });
});
