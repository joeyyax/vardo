// Process execution with argument arrays. Never build shell command strings from untrusted data.

import { execFile } from "child_process";
import { promisify } from "util";
import { redactError } from "@/lib/redact";

const execFileRaw = promisify(execFile);

/**
 * `execFile` that redacts credentials from errors. Node puts the whole argv in the message.
 * Don't promisify `execFile` again.
 */
export const execFileAsync = (async (...args: Parameters<typeof execFileRaw>) => {
  try {
    return await execFileRaw(...args);
  } catch (err) {
    throw redactError(err);
  }
}) as typeof execFileRaw;

export type ExecOptions = Parameters<typeof execFileAsync>[2];

/** Throw unless `p` is a non-empty relative path with no `..` or shell metacharacters. */
export function assertSafeSyncPath(p: string): void {
  if (!p || p.trim() === "") {
    throw new Error("Sync path must not be empty");
  }
  if (p.startsWith("/")) {
    throw new Error(`Sync path must be relative, got: ${p}`);
  }
  if (p.includes("..")) {
    throw new Error(`Sync path must not contain '..': ${p}`);
  }
  // These paths reach sh -c scripts.
  if (/[;&|`$()<>\n\r\0]/.test(p)) {
    throw new Error(`Sync path contains unsafe characters: ${p}`);
  }
}
