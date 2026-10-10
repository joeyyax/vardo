// Bring an app's volume rows in line with what a successful deploy mounts.

import { and, eq, isNull } from "drizzle-orm";
import { volumes } from "@/lib/db/schema";
import { projectSlot } from "@/lib/docker/desired-state";
import type { ComposeFile } from "@/lib/docker/compose-types";

/** Rows a deploy still mounts. */
export function liveVolumesOf(appId: string) {
  return and(eq(volumes.appId, appId), isNull(volumes.removedAt));
}

export type VolumeRowState = {
  id: string;
  name: string;
  mountPath: string;
  type: "named" | "bind";
  source: string | null;
  removedAt: Date | null;
};

export type DetectedMount = {
  name: string;
  mountPath: string;
  type: "named" | "bind";
  source: string | null;
};

export type VolumeRowUpdate = {
  id: string;
  name: string;
  set: {
    type: "named" | "bind";
    source: string | null;
    mountPath: string;
    removedAt: null;
    persistent?: boolean;
  };
  /** The mount changed, so the old backup selection no longer applies. */
  resetSelection: boolean;
  note: string;
};

export type VolumeReconcilePlan = {
  updates: VolumeRowUpdate[];
  removals: { id: string; name: string; mountPath: string }[];
  added: DetectedMount[];
};

/** Container paths any service of the compose mounts. */
export function declaredMountPaths(compose: ComposeFile): Set<string> {
  const paths = new Set<string>();
  for (const svc of Object.values(compose.services ?? {})) {
    for (const entry of svc.volumes ?? []) {
      const parts = entry.split(":");
      const target = parts.length >= 2 ? parts[1] : parts[0];
      if (target?.startsWith("/")) paths.add(target.replace(/\/+$/, "") || "/");
    }
  }
  return paths;
}

/** Whether a container belongs to the slot this deploy brought up. Shared and unslotted projects always do. */
export function isNewSlotContainer(project: string | undefined, newProjectName: string): boolean {
  const slot = projectSlot(project);
  if (slot !== "blue" && slot !== "green") return true;
  return project === newProjectName;
}

/**
 * Match detected mounts to rows by mount path, then named volumes by name.
 * Rows left unmatched are removed only when the compose no longer declares their path.
 */
export function planVolumeReconcile(
  rows: VolumeRowState[],
  detected: DetectedMount[],
  declared: Set<string> | null,
): VolumeReconcilePlan {
  const plan: VolumeReconcilePlan = { updates: [], removals: [], added: [] };
  const matched = new Set<string>();
  const pairs: { row: VolumeRowState; mount: DetectedMount }[] = [];
  const unpaired: DetectedMount[] = [];

  for (const mount of detected) {
    const row = rows.find((r) => r.mountPath === mount.mountPath && !matched.has(r.id));
    if (row) {
      matched.add(row.id);
      pairs.push({ row, mount });
    } else {
      unpaired.push(mount);
    }
  }
  for (const mount of unpaired) {
    const row =
      mount.type === "named"
        ? rows.find((r) => r.type === "named" && r.name === mount.name && !matched.has(r.id))
        : undefined;
    if (row) {
      matched.add(row.id);
      pairs.push({ row, mount });
    } else {
      plan.added.push(mount);
    }
  }

  for (const { row, mount } of pairs) {
    const typeChanged = row.type !== mount.type;
    const sourceChanged = mount.type === "bind" && row.source !== mount.source;
    const moved = row.mountPath !== mount.mountPath;
    if (!typeChanged && !sourceChanged && !moved && !row.removedAt) continue;
    const notes: string[] = [];
    if (typeChanged || sourceChanged) notes.push(`${mount.mountPath} now mounts ${mount.source ?? mount.name}`);
    if (moved) notes.push(`${row.name} moved to ${mount.mountPath}`);
    if (row.removedAt && !notes.length) notes.push(`${row.name} is mounted again`);
    plan.updates.push({
      id: row.id,
      name: row.name,
      set: {
        type: mount.type,
        source: mount.type === "bind" ? mount.source : null,
        mountPath: mount.mountPath,
        removedAt: null,
        // `persistent` means Vardo externalized it, which a bind mount never is.
        ...(typeChanged && { persistent: mount.type !== "bind" }),
      },
      resetSelection: typeChanged || sourceChanged,
      note: notes.join(", "),
    });
  }

  if (declared) {
    for (const row of rows) {
      if (matched.has(row.id) || row.removedAt || declared.has(row.mountPath)) continue;
      plan.removals.push({ id: row.id, name: row.name, mountPath: row.mountPath });
    }
  }

  return plan;
}

/** One deploy-log line for the plan, or null when nothing changed. */
export function describeReconcile(plan: VolumeReconcilePlan): string | null {
  const parts = plan.updates.map((u) => u.note);
  if (plan.removals.length) {
    parts.push(
      `no longer declared: ${plan.removals.map((r) => `${r.name} (${r.mountPath})`).join(", ")} — backups skip them`,
    );
  }
  return parts.length ? `[deploy] Volume records updated: ${parts.join("; ")}` : null;
}
