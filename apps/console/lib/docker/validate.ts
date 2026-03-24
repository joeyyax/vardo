// Shared validation helpers for shell-safe interpolation in Docker commands

const SAFE_NAME_RE = /^[a-zA-Z0-9._\-]+$/;

/**
 * Assert that a name (volume, container, project, etc.) is safe to interpolate
 * into shell commands. Throws if the name contains characters that could allow
 * command injection.
 */
export function assertSafeName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid name: ${name}`);
  }
}

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Assert that a git branch name is safe for shell interpolation.
 */
export function assertSafeBranch(branch: string): void {
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

// Mount paths are absolute container paths — same safe character set as names
// but with an optional leading slash and interior slashes allowed.
const SAFE_MOUNT_PATH_RE = /^\/[a-zA-Z0-9._\-/]*$/;

/**
 * Assert that a container mount path is safe to interpolate into shell commands.
 * Must be an absolute path containing only alphanumerics, dots, dashes,
 * underscores, and forward slashes. Rejects metacharacters that could allow
 * command injection (e.g. $, `, (, ), ;, |, &, spaces, quotes).
 */
export function assertSafeMountPath(mountPath: string): void {
  if (!SAFE_MOUNT_PATH_RE.test(mountPath)) {
    throw new Error(`Invalid mount path: ${mountPath}`);
  }
}
