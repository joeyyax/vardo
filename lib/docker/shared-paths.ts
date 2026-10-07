// Anchors a shared service's relative paths outside the slot so its config hash stays stable across slots.

import { join, normalize } from "path";
import type { ComposeFile } from "./compose-types";

/** Where a shared service's relative paths land when the repo doesn't hold them. */
export function sharedPathsDir(appDir: string): string {
  return join(appDir, "shared");
}

export type AnchoredPath = {
  service: string;
  kind: "volume" | "env_file";
  /** Path relative to the slot dir, normalized. */
  rel: string;
  /** Absolute path the definition now names. */
  to: string;
  /** The repo holds it; the slot only ever linked or copied it. */
  inRepo: boolean;
};

/** A relative path inside the slot, normalized, or null. */
function slotRelative(source: string, kind: AnchoredPath["kind"]): string | null {
  if (kind === "volume" && source !== "." && !source.startsWith("./")) return null;
  if (kind === "env_file" && (source.startsWith("/") || source.startsWith("$") || source.startsWith("~"))) return null;
  const rel = normalize(source);
  // `../x` already resolves to one path from either slot.
  if (rel.startsWith("..")) return null;
  return rel;
}

/** Rewrite relative bind sources and env files to absolute paths in the repo or `sharedDir`. Mutates `compose`. */
export function anchorSharedPaths(
  compose: ComposeFile,
  services: Set<string>,
  opts: { repoDir: string | null; repoEntries: Set<string>; sharedDir: string },
): AnchoredPath[] {
  const anchored: AnchoredPath[] = [];
  const anchor = (service: string, kind: AnchoredPath["kind"], source: string): string | null => {
    const rel = slotRelative(source, kind);
    if (rel === null) return null;
    const inRepo = opts.repoDir !== null && opts.repoEntries.has(rel.split("/")[0]);
    const to = rel === "." ? (inRepo ? opts.repoDir! : opts.sharedDir) : join(inRepo ? opts.repoDir! : opts.sharedDir, rel);
    anchored.push({ service, kind, rel, to, inRepo });
    return to;
  };

  for (const name of services) {
    const service = compose.services[name];
    if (!service) continue;
    if (service.volumes) {
      service.volumes = service.volumes.map((mount) => {
        const [source, ...rest] = mount.split(":");
        if (rest.length === 0) return mount;
        const to = anchor(name, "volume", source);
        return to ? [to, ...rest].join(":") : mount;
      });
    }
    if (service.env_file) {
      service.env_file = service.env_file.map((file) => anchor(name, "env_file", file) ?? file);
    }
  }
  return anchored;
}
