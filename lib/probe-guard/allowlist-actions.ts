// Changing the never-ban list. Adding an entry lifts the bans it covers; every change rewrites the guard file.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { logger } from "@/lib/logger";
import { MAX_ALLOW_ENTRIES, allowEntryInputSchema, type AllowEntry, type AllowEntryInput } from "./allowlist";
import { getAllowlist, setAllowlist } from "./allowlist-store";
import { liftBansCovering } from "./bans";
import { resetClientLists } from "./client-lists";
import { syncGuardFile } from "./sync";

const log = logger.child("probe-guard");

export class AllowlistError extends Error {}

async function afterChange(): Promise<void> {
  resetClientLists();
  await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
}

/** Adds an entry, lifting any active ban it covers. Returns the entry and how many bans it lifted. */
export async function addAllowEntry(input: AllowEntryInput, userId: string | null): Promise<{ entry: AllowEntry; lifted: number }> {
  const parsed = allowEntryInputSchema.parse(input);
  const list = await getAllowlist();
  if (list.some((e) => e.value === parsed.value)) throw new AllowlistError(`${parsed.value} is already on the list`);
  if (list.length >= MAX_ALLOW_ENTRIES) throw new AllowlistError(`The list holds at most ${MAX_ALLOW_ENTRIES} entries`);
  const entry: AllowEntry = { id: nanoid(), ...parsed, addedBy: userId, addedAt: new Date().toISOString() };
  await setAllowlist([...list, entry]);

  const lifted = await liftBansCovering(entry.value, userId);
  await afterChange();
  for (const ban of lifted) {
    if (!ban.appId) continue;
    const app = await db.query.apps.findFirst({ where: eq(apps.id, ban.appId), columns: { organizationId: true } });
    if (!app) continue;
    await recordActivity({
      organizationId: app.organizationId,
      action: "security.allowlist_added",
      appId: ban.appId,
      userId: userId ?? undefined,
      metadata: { ip: ban.ip, entry: entry.value },
    }).catch(() => {});
  }
  log.info(`Allowlisted ${entry.value}${lifted.length ? `, lifting ${lifted.length} ban${lifted.length === 1 ? "" : "s"}` : ""}`);
  return { entry, lifted: lifted.length };
}

export async function updateAllowEntry(id: string, patch: { note?: string; skipGuard?: boolean }): Promise<AllowEntry | null> {
  const list = await getAllowlist();
  const current = list.find((e) => e.id === id);
  if (!current) return null;
  const next = { ...current, ...patch };
  await setAllowlist(list.map((e) => (e.id === id ? next : e)));
  await afterChange();
  return next;
}

export async function removeAllowEntry(id: string): Promise<boolean> {
  const list = await getAllowlist();
  if (!list.some((e) => e.id === id)) return false;
  await setAllowlist(list.filter((e) => e.id !== id));
  await afterChange();
  return true;
}
