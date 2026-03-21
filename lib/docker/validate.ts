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
