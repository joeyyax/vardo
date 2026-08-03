import { describe, it, expect, beforeEach, vi } from "vitest";

// Retiring GlitchTip unpins its rows so the operator can remove them. It must
// never touch a row that is already theirs, and never run twice.

const { dbMock, updates, getSystemSettingRawMock, setSystemSettingMock } = vi.hoisted(() => {
  const updates: { set: Record<string, unknown> }[] = [];
  return {
    updates,
    dbMock: {
      update: vi.fn(() => ({
        set: vi.fn((set: Record<string, unknown>) => {
          updates.push({ set });
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
      query: { apps: { findFirst: vi.fn().mockResolvedValue(null) } },
    },
    getSystemSettingRawMock: vi.fn().mockResolvedValue(null),
    setSystemSettingMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: getSystemSettingRawMock,
  setSystemSetting: setSystemSettingMock,
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { retireGlitchTip } from "@/lib/infra/retire-glitchtip";

const pinned = { id: "app-gt", projectId: "proj-gt", isSystemManaged: true };

describe("retireGlitchTip", () => {
  beforeEach(() => {
    updates.length = 0;
    dbMock.update.mockClear();
    setSystemSettingMock.mockClear();
    getSystemSettingRawMock.mockResolvedValue(null);
    dbMock.query.apps.findFirst.mockResolvedValue(null);
  });

  it("unpins the app, its children and the project", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(pinned);

    await retireGlitchTip();

    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update.set).toMatchObject({ isSystemManaged: false });
    expect(setSystemSettingMock).toHaveBeenCalledWith("glitchtip_retired", expect.any(String));
  });

  it("marks itself done on an install that never had GlitchTip", async () => {
    await retireGlitchTip();

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(setSystemSettingMock).toHaveBeenCalledWith("glitchtip_retired", expect.any(String));
  });

  it("leaves a row the operator already owns alone", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({ ...pinned, isSystemManaged: false });

    await retireGlitchTip();

    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("does not run twice", async () => {
    getSystemSettingRawMock.mockResolvedValue("2026-08-03T00:00:00.000Z");
    dbMock.query.apps.findFirst.mockResolvedValue(pinned);

    await retireGlitchTip();

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(setSystemSettingMock).not.toHaveBeenCalled();
  });
});
