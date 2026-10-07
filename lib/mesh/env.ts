import { existsSync } from "node:fs";

/** True when the current process is running inside a Docker container. */
export function isRunningInContainer(): boolean {
  return existsSync("/.dockerenv");
}

/** True when NODE_ENV is development. */
export function isDevMode(): boolean {
  return process.env.NODE_ENV === "development";
}
