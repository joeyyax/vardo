// Batch apply never crosses a major; Plan upgrade does, one service at a time.

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
vi.mock("@/lib/docker/image-updates/apply", () => ({ setServiceImageTag, setImageRefTag: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));

import { applyImageUpdate } from "@/lib/docker/image-updates/apply-update";

const request = { orgId: "org-1", appId: "app-1", userId: "user-1", service: "web" };

beforeEach(() => {
  vi.clearAllMocks();
  resolveUpdatableApp.mockResolvedValue({
    id: "app-1",
    name: "blog",
    displayName: "Blog",
    deployType: "compose",
    imageName: null,
    composeContent: "services:\n  web:\n    image: ghost:5.2\n",
    composeService: null,
    composeOwnerId: "app-1",
    isSystemManaged: false,
  });
  getAppUpdateStatus.mockResolvedValue({
    services: [
      {
        service: "web",
        image: "ghost:5.2",
        currentTag: "5.2",
        status: "update",
        latestTag: "5.3",
        severity: "minor",
        unorderable: [],
        available: ["5.3"],
        majorAvailable: "6.1",
        majorTags: ["6.1", "6.0"],
        track: { mode: "latest", explicit: false, defaultMode: "latest", reason: null, major: 5 },
        majorHeld: false,
        reasons: [],
        majorLocked: false,
        error: null,
        checkedAt: null,
        stale: false,
      },
    ],
    ignored: [],
    blockedMigration: null,
  });
  setServiceImageTag.mockImplementation((_content: string, _service: string, tag: string) => ({
    content: `services:\n  web:\n    image: ghost:${tag}\n`,
    previousImage: "ghost:5.2",
    newImage: `ghost:${tag}`,
  }));
});

describe("applyImageUpdate — majors", () => {
  it("refuses a major when the caller disallows them", async () => {
    const outcome = await applyImageUpdate({ ...request, tag: "6.1", allowMajor: false });
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(setServiceImageTag).not.toHaveBeenCalled();
  });

  it("still takes a minor in the same call shape", async () => {
    const outcome = await applyImageUpdate({ ...request, tag: "5.3", allowMajor: false });
    expect(outcome.ok).toBe(true);
  });

  it("takes any offered major on the single-service path", async () => {
    expect((await applyImageUpdate({ ...request, tag: "6.0" })).ok).toBe(true);
  });
});
