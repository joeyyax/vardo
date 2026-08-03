// ---------------------------------------------------------------------------
// Which blue-green slot images are superseded, and which are load-bearing.
//
// Instant rollback restarts the standby with `up -d --no-recreate --pull never`.
// Nothing is pulled and nothing is rebuilt, so the standby's containers and the
// images behind them have to still be on the host. A slot that has containers is
// therefore untouchable, running or stopped — the 29 stopped containers here are
// standbys `stopStandbySlot` deliberately left in place.
//
// This is not `docker image prune -a`. Prune reclaims by "nothing references
// this right now", which is exactly the standby generation.
// ---------------------------------------------------------------------------

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

/**
 * Index the compose project names the deployed environments account for.
 *
 * Built forward from the environments rather than by parsing a project string
 * backwards: app and environment names both contain dashes (`browser-mcp`,
 * `pr-166`), so `agents-pr-166-blue` has no unambiguous split.
 */
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

/**
 * Which generation a compose project names, or null when nothing on this host
 * accounts for it.
 *
 * Bare `blue` and `green` are the oldest scheme, from before the project prefix
 * carried the app and environment. Nothing writes them now, so they cannot name
 * a live slot — but they are unmistakably Vardo's, so they are still attributed.
 */
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
 * Decide one image.
 *
 * Two guards do the real work, and they cover different failures. Container
 * presence protects rollback: a slot with containers is one `up --no-recreate`
 * away from serving. The `current` symlink protects an app that was taken all
 * the way down, where both slots lost their containers and only the symlink
 * still says which generation a restart would use.
 *
 * `readlink` is the only authority on which slot is live — both slot directories
 * share one git dir, so their shas are identical and prove nothing.
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

/**
 * The tag to remove, or a refusal.
 *
 * Compose names what it builds `<project>-<service>`, never registry-qualified.
 * A qualified tag means the service pinned an `image:` a registry owns, and the
 * sweep stays out of the other sweep's territory.
 */
export type SlotRefVerdict =
  | { take: true; ref: string }
  | { take: false; reason: SlotSkipReason };

export function slotImageRef(repoTags: string[]): SlotRefVerdict {
  const tags = repoTags.filter((t) => t && t !== "<none>:<none>");
  if (tags.length === 0) return { take: false, reason: "untagged" };
  if (tags.some((t) => t.includes("/"))) return { take: false, reason: "registry-image" };
  return { take: true, ref: tags[0] };
}
