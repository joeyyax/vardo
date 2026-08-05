import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// needsSetup — the first-run gate. Once an account has been seen the gate is
// latched in system_settings, so a later empty user table must not reopen it.
// ---------------------------------------------------------------------------

const { mockFindFirst, mockSelect, mockSetSystemSetting } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockSelect: vi.fn(),
  mockSetSystemSetting: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { systemSettings: { findFirst: mockFindFirst } },
    select: mockSelect,
  },
}));

vi.mock("@/lib/system-settings", () => ({
  setSystemSetting: mockSetSystemSetting,
}));

import { needsSetup } from "@/lib/setup";

function userRows(rows: { count: number | string }[]) {
  mockSelect.mockReturnValue({ from: () => Promise.resolve(rows) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue(undefined);
  userRows([{ count: 0 }]);
});

describe("needsSetup", () => {
  it("is open on a fresh instance with no accounts", async () => {
    expect(await needsSetup()).toBe(true);
    expect(mockSetSystemSetting).not.toHaveBeenCalled();
  });

  it("latches shut the first time an account is seen", async () => {
    userRows([{ count: 1 }]);

    expect(await needsSetup()).toBe(false);
    expect(mockSetSystemSetting).toHaveBeenCalledWith("setup_completed", expect.any(String));
  });

  it("stays shut when the user table is emptied after setup", async () => {
    mockFindFirst.mockResolvedValue({ key: "setup_completed" });
    userRows([{ count: 0 }]);

    expect(await needsSetup()).toBe(false);
  });

  it("does not count users once latched", async () => {
    mockFindFirst.mockResolvedValue({ key: "setup_completed" });

    await needsSetup();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("throws when the account count is unreadable", async () => {
    userRows([]);

    await expect(needsSetup()).rejects.toThrow(/whether any accounts exist/);
  });

  it("throws when the latch cannot be read", async () => {
    mockFindFirst.mockRejectedValue(new Error("connection refused"));

    await expect(needsSetup()).rejects.toThrow("connection refused");
  });
});
