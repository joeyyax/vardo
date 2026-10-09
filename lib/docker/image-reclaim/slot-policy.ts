// Which blue-green slot images are superseded, and which are load-bearing.
// A slot with containers (running or stopped) is untouchable: instant rollback restarts it with --pull never.

import { isSelfApp } from "../self-env";
import type { Slot } from "../slots";
import type { ReclaimPolicy } from "./policy";

/** Which naming scheme an image's compose project belongs to. */
export type SlotGeneration =
  /** `<app>-<env>-<slot>`, the scheme every deploy path writes today. */
  | { kind: "slot"; appName: string; envName: string; slot: Slot }
  /** A build from before slot projects. No `current` symlink can name it. */
  | { kind: "legacy"; appName: string | null };

export type SlotSkipReason =
  | "self"
  | "system-managed"
  | "pinned-by-user"
  | "live-slot"
  | "current-unreadable"
  | "slot-in-use"
  | "registry-image"
  | "untagged"
  | "unknown-project";

/** Human-readable explanation, used verbatim in the preview and the report. */
export const SLOT_SKIP_COPY: Record<SlotSkipReason, string> = {
  self: "Vardo itself",
  "system-managed": "Managed by Vardo",
  "pinned-by-user": "Pinned — reclamation turned off for this app",
  "live-slot": "The slot 'current' points at — removing it turns a restart into a rebuild",
  "current-unreadable":
    "Cannot read 'current' — the live slot is unknown, so neither slot is safe to take",
  "slot-in-use": "The slot still has containers — instant rollback starts them against this image",
  "registry-image": "Registry-qualified tag — pulled, not a locally built slot image",
  untagged: "Untagged — outside this sweep's scope",
  "unknown-project": "Compose project does not belong to a Vardo app",
};

/** Advisory on a candidate the policy takes. Not a refusal. */
export type SlotWarningReason = "rollback-target";

export const SLOT_WARNING_COPY: Record<SlotWarningReason, (appName: string) => string> = {
  "rollback-target": (appName) =>
    `Rollback target for ${appName}. Removing it turns instant rollback into a rebuild.`,
};

/** An environment directory that holds blue-green slots. */
export interface SlotEnvironment {
  appName: string;
  envName: string;
  /** `readlink` on `current`, or null when it is missing, unreadable or not a slot. */
  currentSlot: Slot | null;
}

/** Per-app reclamation settings, when the app still has a database row. */
export interface SlotApp {
  name: string;
  isSystemManaged: boolean;
  policy: ReclaimPolicy;
}

export interface SlotIndex {
  /** `<app>-<env>-<slot>` → the environment and slot it names. */
  slots: Map<string, { environment: SlotEnvironment; slot: Slot }>;
  /** `<app>` and `<app>-<env>` → app name. The pre-slot project names. */
  legacy: Map<string, string>;
}

/** Index the compose project names the deployed environments account for. Project names can't be split on dashes. */
export function buildSlotIndex(environments: SlotEnvironment[]): SlotIndex {
  const slots: SlotIndex["slots"] = new Map();
  const legacy: SlotIndex["legacy"] = new Map();

  for (const environment of environments) {
    const prefix = `${environment.appName}-${environment.envName}`;
    for (const slot of ["blue", "green"] as const) {
      slots.set(`${prefix}-${slot}`, { environment, slot });
    }
    legacy.set(prefix, environment.appName);
    legacy.set(environment.appName, environment.appName);
  }

  return { slots, legacy };
}

/** Which generation a compose project names, or null. Bare `blue`/`green` are legacy and never live. */
export function classifyProject(project: string, index: SlotIndex): SlotGeneration | null {
  const slot = index.slots.get(project);
  if (slot) {
    return {
      kind: "slot",
      appName: slot.environment.appName,
      envName: slot.environment.envName,
      slot: slot.slot,
    };
  }

  const legacyApp = index.legacy.get(project);
  if (legacyApp) return { kind: "legacy", appName: legacyApp };

  if (project === "blue" || project === "green") return { kind: "legacy", appName: null };

  return null;
}

export type SlotVerdict = { take: true } | { take: false; reason: SlotSkipReason };

/**
 * Decide one image. Container presence protects rollback; the `current` symlink protects a fully stopped app.
 * `readlink` is the only authority on the live slot: both slots share one git dir, so shas prove nothing.
 */
export function decideSlotImage(input: {
  generation: SlotGeneration;
  /** `current` for the generation's environment. Ignored for legacy projects. */
  currentSlot: Slot | null;
  /** Whether the compose project has any container at all, stopped included. */
  projectHasContainers: boolean;
  /** The app's database row, when it still has one. */
  app: SlotApp | null;
}): SlotVerdict {
  const { generation, currentSlot, projectHasContainers, app } = input;

  const appName = app?.name ?? generation.appName;
  if (appName && isSelfApp(appName)) return { take: false, reason: "self" };
  if (app?.isSystemManaged) return { take: false, reason: "system-managed" };
  if (app?.policy === "never") return { take: false, reason: "pinned-by-user" };

  if (generation.kind === "slot") {
    if (currentSlot === null) return { take: false, reason: "current-unreadable" };
    if (currentSlot === generation.slot) return { take: false, reason: "live-slot" };
  }

  if (projectHasContainers) return { take: false, reason: "slot-in-use" };

  return { take: true };
}

/** The tag to remove, or a refusal. Registry-qualified tags are pulled images, not slot builds. */
export type SlotRefVerdict =
  | { take: true; ref: string }
  | { take: false; reason: SlotSkipReason };

export function slotImageRef(repoTags: string[]): SlotRefVerdict {
  const tags = repoTags.filter((t) => t && t !== "<none>:<none>");
  if (tags.length === 0) return { take: false, reason: "untagged" };
  if (tags.some((t) => t.includes("/"))) return { take: false, reason: "registry-image" };
  return { take: true, ref: tags[0] };
}
