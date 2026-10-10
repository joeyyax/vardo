import { randomBytes } from "crypto";
import { hostname } from "os";

const g = globalThis as unknown as { __vardo_instance_id?: string };

/** This process, as lease holders and heartbeats name it: host, pid and a per-boot suffix. */
export function instanceId(): string {
  return (g.__vardo_instance_id ??= `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`);
}

/** Stable across restarts of one container: its hostname. */
export function instanceName(): string {
  return hostname();
}
