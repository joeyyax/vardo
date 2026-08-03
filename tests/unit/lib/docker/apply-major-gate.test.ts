// ---------------------------------------------------------------------------
// Pinning a way out of a stopped deploy.
//
// A floating tag never has a "verified update" to offer, so the only tags the
// apply path can accept here are the two majors the gate read off real local
// images. Anything else still has to come from a registry check.
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

const request = { orgId: "org-1", appId: "app-1", userId: "user-1", service: "db" };

beforeEach(() => {
  vi.clearAllMocks();
  resolveUpdatableApp.mockResolvedValue({
    id: "app-1",
    name: "outline",
    displayName: "Outline",
    deployType: "compose",
    imageName: null,
    composeContent: "services:\n  db:\n    image: postgres:latest\n",
    composeService: null,
    composeOwnerId: "app-1",
    isSystemManaged: false,
  });
  getAppUpdateStatus.mockResolvedValue({
    services: [
      {
        service: "db",
        image: "postgres:latest",
        currentTag: "latest",
        status: "drift",
        latestTag: null,
        severity: null,
        unorderable: [],
        available: [],
        majorAvailable: null,
        majorLocked: true,
        error: null,
        checkedAt: null,
        stale: false,
      },
    ],
    ignored: [],
    updateCount: 1,
    highestSeverity: null,
    hasUnknown: false,
    blockedMigration: {
      appId: "app-1",
      appName: "Outline",
      deploymentId: "deploy-1",
      blockedAt: new Date().toISOString(),
      services: [
        {
          service: "db",
          image: "postgres:latest",
          from: 16,
          to: 18,
          engine: "postgres",
          plan: null,
        },
      ],
    },
  });
  setServiceImageTag.mockReturnValue({
    content: "services:\n  db:\n    image: postgres:16\n",
    previousImage: "postgres:latest",
    newImage: "postgres:16",
  });
});

describe("applyImageUpdate — major gate", () => {
  it("pins the major the app is already running", async () => {
    const outcome = await applyImageUpdate({ ...request, tag: "16", majorGate: true });

    expect(outcome.ok).toBe(true);
    expect(setServiceImageTag).toHaveBeenCalledWith(expect.any(String), "db", "16");
  });

  it("makes the forward pin ask for the acknowledgement", async () => {
    const outcome = await applyImageUpdate({ ...request, tag: "18", majorGate: true });

    expect(outcome).toMatchObject({ ok: false, status: 409, requiresMigration: true, from: "16" });
    expect(setServiceImageTag).not.toHaveBeenCalled();
  });

  it("takes the forward pin once it is acknowledged", async () => {
    const outcome = await applyImageUpdate({
      ...request,
      tag: "18",
      majorGate: true,
      acknowledgeMigration: true,
    });

    expect(outcome.ok).toBe(true);
  });

  it("refuses a tag the gate never reported", async () => {
    const outcome = await applyImageUpdate({ ...request, tag: "17", majorGate: true });

    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(setServiceImageTag).not.toHaveBeenCalled();
  });

  it("refuses the gate's tags without the gate flag", async () => {
    const outcome = await applyImageUpdate({ ...request, tag: "16" });

    expect(outcome).toMatchObject({ ok: false, status: 409 });
  });
});
