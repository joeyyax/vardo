// Owner checks for Docker volumes found by name, which two apps' names can both derive.

import { and, eq, notInArray, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, environments } from "@/lib/db/schema";
import { dockerRequest } from "./client";

type Holder = { Names?: string[]; Labels?: Record<string, string> };

/** The app, its parent and its siblings or children: one compose project between them. */
export async function appFamily(appId: string): Promise<string[]> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId), columns: { parentAppId: true } });
  const root = app?.parentAppId ?? appId;
  const children = await db.select({ id: apps.id }).from(apps).where(eq(apps.parentAppId, root));
  return [...new Set([appId, root, ...children.map((c) => c.id)])];
}

/** Containers of another app that mount the volume, by name. */
export async function foreignVolumeHolders(family: string[], volume: string): Promise<string[]> {
  const filters = encodeURIComponent(JSON.stringify({ volume: [volume] }));
  const holders = await dockerRequest<Holder[]>("GET", `/containers/json?all=true&filters=${filters}`);
  return (holders ?? [])
    .filter((c) => {
      const owner = c.Labels?.["vardo.project.id"];
      return !!owner && !family.includes(owner);
    })
    .map((c) => (c.Names?.[0] ?? "").replace(/^\//, ""));
}

/** The compose project a Vardo volume name belongs to: everything before the first `_`. */
export function volumeProject(volume: string): string | null {
  const i = volume.indexOf("_");
  return i > 0 ? volume.slice(0, i) : null;
}

/** Another app whose own names derive this volume's project, or null. */
export async function otherPrefixOwner(family: string[], volume: string): Promise<string | null> {
  const project = volumeProject(volume);
  if (!project) return null;
  const [row] = await db
    .select({ name: apps.name })
    .from(apps)
    .leftJoin(environments, eq(environments.appId, apps.id))
    .where(
      and(
        notInArray(apps.id, family),
        or(
          sql`${apps.name} || '-' || ${environments.name} = ${project}`,
          sql`${apps.name} || '-blue' = ${project}`,
          sql`${apps.name} || '-green' = ${project}`,
        ),
      ),
    )
    .limit(1);
  return row?.name ?? null;
}

/** Why a name-derived volume isn't this app's, or null when nothing else claims it. */
export async function volumeOwnerProblem(appId: string, volume: string): Promise<string | null> {
  const family = await appFamily(appId);
  const holders = await foreignVolumeHolders(family, volume).catch(() => []);
  if (holders.length > 0) return `${volume} is mounted by another app (${holders.join(", ")})`;
  const owner = await otherPrefixOwner(family, volume);
  return owner ? `${volume} is named for another app (${owner})` : null;
}
