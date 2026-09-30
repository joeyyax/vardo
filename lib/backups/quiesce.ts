// ---------------------------------------------------------------------------
// Quiesce: stop every running container that mounts a restore destination,
// and start them again afterward. A restore that swaps files under a running
// process hands it a mix of old and new data.
// ---------------------------------------------------------------------------

import { hostname } from "os";
import { dockerRequest, startContainer, stopContainer } from "@/lib/docker/client";
import { holdStopped, releaseStopped } from "@/lib/docker/stop-holds";

export type RestoreDestination =
  | { kind: "volume"; name: string }
  | { kind: "bind"; path: string };

type RawMount = { Type?: string; Name?: string; Source?: string; RW?: boolean };
type RawRunning = { Id: string; Names?: string[]; Mounts?: RawMount[] };

const STOP_TIMEOUT_SECONDS = 30;

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Whether a mount can write the destination. Read-only mounts and binds of a
 * parent directory are left alone: those are host-wide tools, not the app.
 */
export function mountTouches(mount: RawMount, dest: RestoreDestination): boolean {
  if (mount.RW === false) return false;
  if (dest.kind === "volume") return mount.Type === "volume" && mount.Name === dest.name;
  if (mount.Type !== "bind" || !mount.Source) return false;
  const src = trimSlash(mount.Source);
  const target = trimSlash(dest.path);
  return src === target || src.startsWith(`${target}/`);
}

/** Running containers mounting the destination, less the one running this process. */
export async function containersMounting(
  dest: RestoreDestination,
  selfId: string = hostname(),
): Promise<{ id: string; name: string }[]> {
  const running = await dockerRequest<RawRunning[]>("GET", "/containers/json");
  // Docker sets a container's hostname to its short id.
  const self = /^[0-9a-f]{12,64}$/.test(selfId) ? selfId : null;
  return (running ?? [])
    .filter((c) => !(self && c.Id.startsWith(self)))
    .filter((c) => (c.Mounts ?? []).some((m) => mountTouches(m, dest)))
    .map((c) => ({ id: c.Id, name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "") }));
}

/**
 * Stop what mounts the destination. `resume` starts them again and returns the
 * names that would not start. A stop that fails restarts whatever it already
 * stopped and throws, so nothing is restored under a live writer.
 */
export async function quiesce(
  dest: RestoreDestination,
  log: (msg: string) => void,
): Promise<{ stopped: string[]; resume: () => Promise<string[]> }> {
  const targets = await containersMounting(dest);
  const stopped: { id: string; name: string }[] = [];

  const resume = async (): Promise<string[]> => {
    const failed: string[] = [];
    for (const c of stopped) {
      try {
        await startContainer(c.id);
      } catch (err) {
        failed.push(c.name);
        log(`WARNING: ${c.name} did not start again — ${err instanceof Error ? err.message : err}`);
      } finally {
        releaseStopped(c.id);
      }
    }
    if (stopped.length > 0 && failed.length === 0) {
      log(`Started ${stopped.map((c) => c.name).join(", ")} again`);
    }
    return failed;
  };

  for (const c of targets) {
    try {
      log(`Stopping ${c.name} for the restore`);
      holdStopped(c.id, "restore");
      await stopContainer(c.id, STOP_TIMEOUT_SECONDS);
      stopped.push(c);
    } catch (err) {
      releaseStopped(c.id);
      await resume();
      throw new Error(
        `Could not stop ${c.name} before restoring — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { stopped: stopped.map((c) => c.name), resume };
}
