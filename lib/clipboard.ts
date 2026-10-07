import { toast } from "@/lib/messenger";

export const COPY_FAILED_MESSAGE = "Copy failed — select and copy it manually";

/**
 * Write to the clipboard; toast and return false when refused.
 * Promises go through ClipboardItem to keep the click's permission while the text loads.
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
