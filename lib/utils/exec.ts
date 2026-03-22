/**
 * Safe process execution utilities.
 *
 * All helpers here use `execFile` / `spawn` with argument arrays so that
 * user-supplied values are passed directly to the OS without shell
 * interpretation. Never construct shell command strings with untrusted data.
 */

import { execFile } from "child_process";
import { promisify } from "util";

export const execFileAsync = promisify(execFile);

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
