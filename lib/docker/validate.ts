// Validation for shell-safe interpolation in Docker commands.

const SAFE_NAME_RE = /^[a-zA-Z0-9._\-]+$/;

/** Assert a volume, container or project name is safe to interpolate into shell commands. */
export function assertSafeName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid name: ${name}`);
  }
}

const SAFE_BRANCH_RE = /^(?!-)[a-zA-Z0-9._\-/]+$/;

/** A branch name git can't read as an option. */
export function isSafeBranch(branch: string): boolean {
  return SAFE_BRANCH_RE.test(branch);
}

export function assertSafeBranch(branch: string): void {
  if (!isSafeBranch(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

/** HTTPS only: other transports (ext::, file://, local paths) can run commands or read the host. */
export function isSafeGitUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function assertSafeGitUrl(url: string): void {
  if (!isSafeGitUrl(url)) {
    throw new Error(`Only HTTPS git URLs are allowed: ${url}`);
  }
}

const SAFE_GIT_SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** Assert a git commit SHA is a plain hex object name. */
export function assertSafeGitSha(sha: string): void {
  if (!SAFE_GIT_SHA_RE.test(sha)) {
    throw new Error(`Invalid git SHA: ${sha}`);
  }
}

const SAFE_MOUNT_PATH_RE = /^\/[a-zA-Z0-9._\-/]*$/;

/** Assert an absolute container mount path is safe to interpolate into shell commands. */
export function assertSafeMountPath(mountPath: string): void {
  if (!SAFE_MOUNT_PATH_RE.test(mountPath)) {
    throw new Error(`Invalid mount path: ${mountPath}`);
  }
}
