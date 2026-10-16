// Whether the device behind Docker's data root sits on LUKS, from the host mount table and sysfs.

import { readdirSync, readFileSync } from "fs";
import type { Judgement } from "./types";

/** Read access to sysfs, so tests can supply a fixture tree. Null when the path isn't readable. */
export type Sys = { read(path: string): string | null; list(path: string): string[] | null };

export const HOST_MOUNTS_FILE = "/host-proc/1/mounts";
export const DEFAULT_DATA_ROOT = "/var/lib/docker";
const MAX_DEPTH = 8;
const ENCRYPTED_UUID = /^CRYPT-(LUKS\d*|PLAIN)/;

export const realSys: Sys = {
  read: (p) => {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      return null;
    }
  },
  list: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return null;
    }
  },
};

type Mount = { source: string; target: string; fstype: string };

export function parseMountTable(text: string): Mount[] {
  const unescape = (s: string) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return text.split("\n").flatMap((line) => {
    const [source, target, fstype] = line.split(" ");
    return source && target && fstype ? [{ source: unescape(source), target: unescape(target), fstype }] : [];
  });
}

/** The mount holding a path: the longest target that prefixes it, the last one listed winning ties. */
export function mountFor(path: string, mounts: Mount[]): Mount | null {
  let best: Mount | null = null;
  for (const m of mounts) {
    const covers = m.target === "/" || path === m.target || path.startsWith(`${m.target}/`);
    if (covers && (!best || m.target.length >= best.target.length)) best = m;
  }
  return best;
}

/** The kernel block device name for a `/dev` path, or null when it can't be mapped. */
export function kernelName(source: string, sys: Sys): string | null {
  const dmNames = (sys.list("/sys/class/block") ?? []).filter((n) => n.startsWith("dm-"));
  const byDmName = (name: string) => dmNames.find((n) => sys.read(`/sys/class/block/${n}/dm/name`) === name) ?? null;
  const mapper = /^\/dev\/mapper\/(.+)$/.exec(source);
  if (mapper) return byDmName(mapper[1]);
  const lvm = /^\/dev\/([^/]+)\/([^/]+)$/.exec(source);
  if (lvm && lvm[1] !== "disk" && lvm[1] !== "mapper") return byDmName(`${lvm[1].replace(/-/g, "--")}-${lvm[2].replace(/-/g, "--")}`);
  const plain = /^\/dev\/([^/]+)$/.exec(source);
  if (plain && sys.list(`/sys/class/block/${plain[1]}`)) return plain[1];
  return null;
}

type Leaf = { kind: "encrypted"; type: string } | { kind: "plain"; name: string };

function walk(name: string, sys: Sys, depth: number, trail: string[]): Leaf[] {
  const uuid = sys.read(`/sys/class/block/${name}/dm/uuid`);
  const crypt = uuid ? ENCRYPTED_UUID.exec(uuid) : null;
  if (crypt) return [{ kind: "encrypted", type: crypt[1].startsWith("LUKS") ? "LUKS" : "dm-crypt" }];
  const below = sys.list(`/sys/class/block/${name}/slaves`) ?? [];
  if (below.length === 0 || depth >= MAX_DEPTH) {
    trail.push(name);
    return [{ kind: "plain", name }];
  }
  trail.push(name);
  return below.flatMap((n) => walk(n, sys, depth + 1, trail));
}

export function judgeDiskEncryption(input: { mounts: string | null; dataRoot: string; sys: Sys }): Judgement {
  const { mounts, dataRoot, sys } = input;
  if (mounts === null) return { state: "unknown", evidence: `Can't read the host mount table at ${HOST_MOUNTS_FILE}, so the disk can't be checked.` };
  if (sys.list("/sys/class/block") === null) return { state: "unknown", evidence: "Can't see the host's /sys/class/block, so the disk can't be checked." };

  const mount = mountFor(dataRoot, parseMountTable(mounts));
  if (!mount) return { state: "unknown", evidence: `No mount found for ${dataRoot}.` };
  if (!mount.source.startsWith("/dev/")) {
    return { state: "unknown", evidence: `${dataRoot} is on ${mount.fstype} (${mount.source}), not a block device Vardo can inspect.` };
  }
  const top = kernelName(mount.source, sys);
  if (!top) return { state: "unknown", evidence: `Can't map ${mount.source} to a kernel device.` };

  const trail: string[] = [];
  const leaves = walk(top, sys, 0, trail);
  const encrypted = leaves.filter((l) => l.kind === "encrypted");
  const where = `${dataRoot} is on ${mount.source}`;
  if (encrypted.length === leaves.length) {
    return { state: "passing", evidence: `${where}, backed by ${encrypted[0].type}.` };
  }
  if (encrypted.length > 0) {
    return { state: "unknown", evidence: `${where}, which spans devices that are partly encrypted. Can't tell where the data sits.` };
  }
  return {
    state: "failing",
    evidence: `${where} (${[...new Set(trail)].join(", ")}) with no LUKS layer. Encryption done by the provider isn't visible from here.`,
  };
}
