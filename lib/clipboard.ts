import { toast } from "@/lib/messenger";

export const COPY_FAILED_MESSAGE = "Copy failed — select and copy it manually";

/**
 * Writes to the clipboard. Toasts and returns false when the write is refused.
 * A promise is written through ClipboardItem so the write keeps the click's
 * permission while the text is fetched; a promise that rejects isn't toasted.
 */
export async function copyToClipboard(text: string | Promise<string>): Promise<boolean> {
  try {
    if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
    return true;
  } catch {
    const resolved = await Promise.resolve(text).then(() => true, () => false);
    if (resolved) toast.error(COPY_FAILED_MESSAGE);
    return false;
  }
}
