import { toast } from "@/lib/messenger";

export const COPY_FAILED_MESSAGE = "Copy failed — select and copy it manually";

/** Writes to the clipboard. Toasts and returns false when the write is refused. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error(COPY_FAILED_MESSAGE);
    return false;
  }
}
