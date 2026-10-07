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

  it("writes pending text through ClipboardItem", async () => {
    const write = vi.fn(async (items: { items: Record<string, Promise<Blob>> }[]) => {
      expect(await (await items[0].items["text/plain"]).text()).toBe("later");
    });
    vi.stubGlobal("ClipboardItem", class { constructor(public items: Record<string, Promise<Blob>>) {} });
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    expect(await copyToClipboard(Promise.resolve("later"))).toBe(true);
    expect(write).toHaveBeenCalledOnce();
  });

  it("falls back to writeText for pending text without ClipboardItem", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyToClipboard(Promise.resolve("later"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("later");
  });

  it("leaves a rejected text promise to the caller", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    const text = Promise.reject(new Error("no link"));
    text.catch(() => {});
    expect(await copyToClipboard(text)).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});
