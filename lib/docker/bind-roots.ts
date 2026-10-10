// Host roots an untrusted app may bind-mount from, and the instance admin's additions.

import { isAbsolute, posix } from "path";

import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";

/** Used when VARDO_BIND_ROOTS is unset. */
export const DEFAULT_BIND_ROOTS = ["/mnt", "/srv", "/data"];

const ALLOWLIST_KEY = "bindMountAllowlist";
const warningsKey = (appId: string) => `bindMountWarnings:${appId}`;

/** A normalized absolute path, or null. */
export function normalizeHostPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed) || trimmed.includes("\0")) return null;
  const normalized = posix.normalize(trimmed).replace(/\/+$/, "");
  return normalized || null;
}

/** Roots from VARDO_BIND_ROOTS, comma-separated. Empty means the default. */
export function envBindRoots(raw = process.env.VARDO_BIND_ROOTS): string[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BIND_ROOTS;
  return raw.split(",").map(normalizeHostPath).filter((p): p is string => !!p);
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Paths an instance admin allowed. */
export async function getAllowedBindPaths(): Promise<string[]> {
  return parseList(await getSystemSettingRaw(ALLOWLIST_KEY));
}

/** Every root a bind source may sit under. Without the admin's list, only VARDO_BIND_ROOTS. */
export async function bindRoots(): Promise<string[]> {
  const allowed = await getAllowedBindPaths().catch(() => []);
  return [...new Set([...envBindRoots(), ...allowed])];
}

/** Add a path to the instance allowlist. Returns the list. */
export async function allowBindPath(raw: string): Promise<string[]> {
  const path = normalizeHostPath(raw);
  if (!path || path === "/") throw new Error("Give an absolute path other than /");
  const list = await getAllowedBindPaths();
  if (!list.includes(path)) list.push(path);
  await setSystemSetting(ALLOWLIST_KEY, JSON.stringify(list.sort()));
  return list;
}

/** Bind sources outside the allowlist that an app's last deploy kept with a warning. */
export async function getBindWarnings(appId: string): Promise<string[]> {
  return parseList(await getSystemSettingRaw(warningsKey(appId)));
}

export async function setBindWarnings(appId: string, paths: string[]): Promise<void> {
  await setSystemSetting(warningsKey(appId), JSON.stringify([...new Set(paths)].sort()));
}
