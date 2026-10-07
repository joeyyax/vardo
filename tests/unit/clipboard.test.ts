import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const error = vi.fn();
vi.mock("@/lib/messenger", () => ({ toast: { error: (...a: unknown[]) => error(...a) } }));

import { copyToClipboard, COPY_FAILED_MESSAGE } from "@/lib/clipboard";

describe("copyToClipboard", () => {
  beforeEach(() => error.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it("returns true and stays quiet when the write succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyToClipboard("abc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
    expect(error).not.toHaveBeenCalled();
  });

  it("returns false and toasts when the write rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    expect(await copyToClipboard("abc")).toBe(false);
    expect(error).toHaveBeenCalledWith(COPY_FAILED_MESSAGE);
  });

  it("returns false when the clipboard API is missing", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyToClipboard("abc")).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
