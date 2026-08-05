/**
 * Safe process execution utilities.
 *
 * All helpers here use `execFile` / `spawn` with argument arrays so that
 * user-supplied values are passed directly to the OS without shell
 * interpretation. Never construct shell command strings with untrusted data.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { redactError } from "@/lib/redact";

const execFileRaw = promisify(execFile);

/**
 * `execFile`, with credentials stripped from a failure before it propagates.
 * Node builds the error message out of the whole argv, so any secret passed as
 * an argument would otherwise reach every logger that prints the error.
 * Use this rather than promisifying `execFile` again.
 */
export const execFileAsync = (async (...args: Parameters<typeof execFileRaw>) => {
  try {
    return await execFileRaw(...args);
  } catch (err) {
    throw redactError(err);
  }
}) as typeof execFileRaw;

export type ExecOptions = Parameters<typeof execFileAsync>[2];

/**
 * Validate that a file path is safe to use in volume sync operations.
 *
 * Rules:
 * - Must not be empty
 * - Must not contain `..` (path traversal)
 * - Must not start with `/` (absolute paths would escape the mount)
 * - Must not contain shell metacharacters: ; | & ` $ ( ) < > \n \r \0
 *
 * Throws an Error with a descriptive message if any rule is violated.
 */
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
  // Reject shell metacharacters that could inject commands into sh -c scripts
  if (/[;&|`$()<>\n\r\0]/.test(p)) {
    throw new Error(`Sync path contains unsafe characters: ${p}`);
  }
}
