import { existsSync } from "node:fs";

/** True when the current process is running inside a Docker container. */
export function isRunningInContainer(): boolean {
  return existsSync("/.dockerenv") || !!process.env.DOCKER_HOST;
}

/**
 * True when running in local dev mode — either NODE_ENV=development or
 * outside a container (e.g. pnpm dev on the developer's machine).
 */
export function isDevMode(): boolean {
  return process.env.NODE_ENV === "development" || !isRunningInContainer();
}
