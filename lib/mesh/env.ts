import { existsSync } from "node:fs";

/** True when the current process is running inside a Docker container. */
export function isRunningInContainer(): boolean {
  return existsSync("/.dockerenv");
}

/** True when running in local dev mode (NODE_ENV=development). */
export function isDevMode(): boolean {
  return process.env.NODE_ENV === "development";
}
