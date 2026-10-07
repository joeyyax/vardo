// Which volumes an enrolled app backs up by default. The first matching rule decides.

import { resolve } from "path";
import type { Durability } from "./durability";

/** Above this, a volume is listed for opt-in rather than backed up. */
export const AUTO_INCLUDE_MAX_BYTES = 10 * 1024 ** 3;

/** Bind sources that are the host's, never an app's. Prefix-matched. */
export const HOST_PATH_PREFIXES = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var/run",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/boot",
  "/root",
  "/home",
  "/tmp",
  "/var/tmp",
  "/var/lib/docker",
];

/** Filesystem types whose durable copy lives on another machine. */
export const NETWORK_FS_TYPES = [
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "fuse.sshfs",
  "fuse.rclone",
  "glusterfs",
  "ceph",
];

/** Path segments that mark data an app can rebuild or re-download. */
const NAME_RULES: { pattern: RegExp; verdict: "exclude" | "opt-in"; reason: string }[] = [
  {
    pattern: /(^|[-_/])(scratch|cache|tmp|temp|incomplete|downloads?|transcodes?)([-_/]|$)/i,
    verdict: "exclude",
    reason: "Scratch, cache or download space",
  },
  {
    pattern: /(^|[-_/])(models?|blobs)([-_/]|$)/i,
    verdict: "opt-in",
    reason: "Model store — re-downloadable",
  },
];

export type SelectionVerdict = "include" | "exclude" | "opt-in";

export type SelectionDecision = { verdict: SelectionVerdict; reason: string };

export type SelectableVolume = {
  id: string;
  appId: string | null;
  name: string;
  mountPath: string;
  type: "named" | "bind";
  source: string | null;
  persistent: boolean;
  durability: Durability | null;
  backupStrategy: string;
  backupSelection: "include" | "exclude" | null;
};

export type SelectionContext = {
  /** Bind sources of every app on the host, with the app's name. */
  otherBinds: { appId: string; appName: string; source: string }[];
  /** Host mount table: mount point → filesystem type. Empty when unreadable. */
  hostMounts: Map<string, string>;
  /** Measured size. Undefined means not measured; null means measuring failed. */
  sizeBytes?: number | null;
  maxBytes?: number;
};

function under(path: string, prefix: string): boolean {
  return path === prefix || (prefix !== "/" && path.startsWith(prefix + "/"));
}

/** Filesystem type holding `path`, by the longest matching mount point. */
export function fsTypeOf(path: string, hostMounts: Map<string, string>): string | null {
  let best: string | null = null;
  let type: string | null = null;
  for (const [mountPoint, fsType] of hostMounts) {
    if (!under(path, mountPoint) && mountPoint !== "/") continue;
    if (best === null || mountPoint.length > best.length) {
      best = mountPoint;
      type = fsType;
    }
  }
  return type;
}

/** Parse /proc/<pid>/mounts into mount point → filesystem type. */
export function parseMounts(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split("\n")) {
    const [, mountPoint, fsType] = line.split(" ");
    if (!mountPoint || !fsType) continue;
    out.set(mountPoint.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))), fsType);
  }
  return out;
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function bindRule(vol: SelectableVolume, ctx: SelectionContext): SelectionDecision | null {
  if (!vol.source) return { verdict: "exclude", reason: "No host path recorded" };
  const source = resolve(vol.source);

  if (source.endsWith(".sock")) return { verdict: "exclude", reason: "Host socket" };
  const host = HOST_PATH_PREFIXES.find((p) => under(source, p));
  if (host || source === "/") return { verdict: "exclude", reason: `Host path under ${host ?? "/"}` };

  const others = ctx.otherBinds.filter((b) => b.appId !== vol.appId);

  // A tree holding two or more other apps' mounts is a workspace, not state.
  const contained = new Set(
    others.filter((b) => b.source !== source && under(resolve(b.source), source)).map((b) => b.appName),
  );
  if (contained.size >= 2) {
    return { verdict: "exclude", reason: `Whole tree shared with ${[...contained].slice(0, 3).join(", ")}` };
  }

  // Inside another app's own mount: that app backs it up.
  const owner = others.find((b) => {
    const parent = resolve(b.source);
    if (parent === source || !under(source, parent)) return false;
    const siblings = new Set(
      ctx.otherBinds.filter((o) => o.appId !== b.appId && under(resolve(o.source), parent)).map((o) => o.appId),
    );
    return siblings.size < 2;
  });
  if (owner) return { verdict: "exclude", reason: `Inside ${owner.appName}'s mount` };

  const fsType = fsTypeOf(source, ctx.hostMounts);
  if (fsType && NETWORK_FS_TYPES.includes(fsType)) {
    return { verdict: "exclude", reason: `Network share (${fsType})` };
  }
  return null;
}

/** Whether an enrolled app backs this volume up by default, and why. */
export function classifyVolume(vol: SelectableVolume, ctx: SelectionContext): SelectionDecision {
  if (vol.backupSelection === "include") return { verdict: "include", reason: "Opted in" };
  if (vol.backupSelection === "exclude") return { verdict: "exclude", reason: "Opted out" };
  if (vol.durability === "rebuildable") return { verdict: "exclude", reason: "Marked rebuildable" };
  if (vol.durability === "external") return { verdict: "exclude", reason: "Marked external" };
  if (vol.backupStrategy === "dump" || vol.durability === "stateful") {
    return { verdict: "include", reason: "Database or marked stateful" };
  }

  if (vol.type === "bind") {
    const ruled = bindRule(vol, ctx);
    if (ruled) return ruled;
  }

  for (const rule of NAME_RULES) {
    const paths = [vol.source ?? "", vol.mountPath, vol.type === "named" ? vol.name : ""];
    if (paths.some((p) => p && rule.pattern.test(p))) return { verdict: rule.verdict, reason: rule.reason };
  }

  const max = ctx.maxBytes ?? AUTO_INCLUDE_MAX_BYTES;
  if (ctx.sizeBytes === null) return { verdict: "opt-in", reason: "Size unknown" };
  if (ctx.sizeBytes !== undefined && ctx.sizeBytes > max) {
    return { verdict: "opt-in", reason: `${formatGb(ctx.sizeBytes)}, over the ${formatGb(max)} limit` };
  }
  return { verdict: "include", reason: "App state" };
}

/** Apps holding at least one volume an enrolled job would back up, ignoring size. */
export function appsWithBackupState(
  rows: (SelectableVolume & { appName: string })[],
  hostMounts: Map<string, string>,
): Set<string> {
  const otherBinds = rows.flatMap((r) =>
    r.type === "bind" && r.appId && r.source ? [{ appId: r.appId, appName: r.appName, source: r.source }] : [],
  );
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.appId || out.has(row.appId)) continue;
    if (classifyVolume(row, { otherBinds, hostMounts }).verdict === "include") out.add(row.appId);
  }
  return out;
}
