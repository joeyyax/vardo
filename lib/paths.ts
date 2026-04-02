// ---------------------------------------------------------------------------
// Centralized path resolution for all Vardo filesystem operations.
//
// Every host path used by deploy, compose, traefik config, logs, and rollback
// monitoring should be resolved through this module — never inline.
//
// Hierarchy:
//   VARDO_HOME_DIR          → root of all Vardo data (default: /opt/vardo)
//   VARDO_PROJECTS_DIR      → app deployment files  (default: $VARDO_HOME_DIR/apps)
//   VARDO_IMAGES_DIR        → docker image storage   (default: $VARDO_HOME_DIR/images)
//   TRAEFIK_DYNAMIC_DIR     → traefik route configs  (default: /etc/traefik/dynamic, shared volume)
//
// Individual overrides take precedence over derived defaults.
// VARDO_DIR is accepted as a fallback for VARDO_HOME_DIR (backwards compat).
// ---------------------------------------------------------------------------

import { resolve, join } from "path";
import { accessSync } from "fs";

/** Root directory for all Vardo data. */
export const VARDO_HOME_DIR = resolve(
  process.env.VARDO_HOME_DIR ||
    process.env.VARDO_DIR ||
    "/opt/vardo",
);

/** Where deployed app files live: compose, .env, blue/green slots. */
export const PROJECTS_DIR = resolve(
  process.env.VARDO_PROJECTS_DIR || join(VARDO_HOME_DIR, "apps"),
);

/** Where docker images are stored. */
export const IMAGES_DIR = resolve(
  process.env.VARDO_IMAGES_DIR || join(VARDO_HOME_DIR, "images"),
);

/** Where Traefik dynamic config files are written (shared volume between frontend and traefik). */
export const TRAEFIK_DYNAMIC_DIR = resolve(
  process.env.TRAEFIK_DYNAMIC_DIR || "/etc/traefik/dynamic",
);

// ---------------------------------------------------------------------------
// App path helpers
// ---------------------------------------------------------------------------

/** Base directory for an app (contains repo/ and env/). */
export function appBaseDir(appName: string): string {
  return join(PROJECTS_DIR, appName);
}

/** Environment directory for an app (contains .active-slot, blue/, green/, current). */
export function appEnvDir(appName: string, envName?: string): string {
  if (envName) {
    return join(PROJECTS_DIR, appName, envName);
  }
  return join(PROJECTS_DIR, appName);
}

/** Specific slot directory (blue or green) within an app environment. */
export function appSlotDir(appName: string, envName: string, slot: string): string {
  return join(appEnvDir(appName, envName), slot);
}

// ---------------------------------------------------------------------------
// Vardo self-management paths
//
// Vardo manages itself as an app in apps/vardo/env/blue|green|current/.
// These helpers resolve paths within that structure. The `current` symlink
// points to the active slot — all runtime references should go through it.
// ---------------------------------------------------------------------------

/** Root of Vardo's self-managed app directory: $VARDO_HOME_DIR/apps/vardo */
export const VARDO_APP_DIR = join(PROJECTS_DIR, "vardo");

/** Environment directory for Vardo's slots: apps/vardo/env/ */
export const VARDO_ENV_DIR = join(VARDO_APP_DIR, "env");

/** The `current` symlink — always points to the active slot. */
export const VARDO_CURRENT_DIR = join(VARDO_ENV_DIR, "current");

/** Compose file in the active slot. */
export const VARDO_COMPOSE_FILE = join(VARDO_CURRENT_DIR, "docker-compose.yml");

/** Resolve a specific slot directory (blue or green). */
export function vardoSlotDir(slot: "blue" | "green"): string {
  return join(VARDO_ENV_DIR, slot);
}

/**
 * Resolve Vardo's compose file at runtime with legacy fallback.
 *
 * Returns VARDO_COMPOSE_FILE (active slot) if the current symlink exists,
 * otherwise falls back to $VARDO_HOME_DIR/docker-compose.yml for legacy
 * flat installs that haven't migrated yet.
 */
export function resolveVardoComposeFile(): string {
  try {
    accessSync(VARDO_COMPOSE_FILE);
    return VARDO_COMPOSE_FILE;
  } catch {
    return join(VARDO_HOME_DIR, "docker-compose.yml");
  }
}

/**
 * Resolve Vardo's source directory at runtime with legacy fallback.
 *
 * Returns VARDO_CURRENT_DIR if the slot layout exists, otherwise
 * VARDO_HOME_DIR for legacy flat installs.
 */
export function resolveVardoDir(): string {
  try {
    accessSync(VARDO_CURRENT_DIR);
    return VARDO_CURRENT_DIR;
  } catch {
    return VARDO_HOME_DIR;
  }
}
