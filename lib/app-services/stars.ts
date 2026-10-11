import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, projects, STAR_KINDS, userStars, type StarKind } from "@/lib/db/schema";
import { authorize, type Actor } from "./actor";
import { InvalidInputError, NotFoundError } from "./errors";

/** The actor's starred ids in their current org. */
export type Stars = { projects: string[]; apps: string[] };

export const starTargetSchema = z.object({ kind: z.enum(STAR_KINDS), targetId: z.string().min(1).max(200) }).strict();
export type StarTarget = z.infer<typeof starTargetSchema>;

function parseTarget(input: unknown): StarTarget {
  const parsed = starTargetSchema.safeParse(input);
  if (!parsed.success) throw new InvalidInputError("Name a project or app to star.");
  return parsed.data;
}

const column = (kind: StarKind) => (kind === "project" ? userStars.projectId : userStars.appId);

/** Every project and app the actor starred in this org. */
export async function listStars(actor: Actor): Promise<Stars> {
  authorize(actor, "org.view");
  const rows = await db.query.userStars.findMany({
    where: and(eq(userStars.userId, actor.userId), eq(userStars.organizationId, actor.org.id)),
    columns: { kind: true, projectId: true, appId: true },
  });
  return {
    projects: rows.flatMap((r) => (r.kind === "project" && r.projectId ? [r.projectId] : [])),
    apps: rows.flatMap((r) => (r.kind === "app" && r.appId ? [r.appId] : [])),
  };
}

/** Whether the actor starred this project or app. */
export async function isStarred(actor: Actor, kind: StarKind, targetId: string): Promise<boolean> {
  authorize(actor, "org.view");
  const row = await db.query.userStars.findFirst({
    where: and(eq(userStars.userId, actor.userId), eq(userStars.organizationId, actor.org.id), eq(column(kind), targetId)),
    columns: { id: true },
  });
  return !!row;
}

/** Stars a project or app in the actor's org. Starring twice is a no-op. */
export async function starTarget(actor: Actor, input: unknown): Promise<StarTarget> {
  authorize(actor, "org.view");
  const target = parseTarget(input);
  const found =
    target.kind === "project"
      ? await db.query.projects.findFirst({
          where: and(eq(projects.id, target.targetId), eq(projects.organizationId, actor.org.id)),
          columns: { id: true },
        })
      : await db.query.apps.findFirst({
          where: and(eq(apps.id, target.targetId), eq(apps.organizationId, actor.org.id)),
          columns: { id: true },
        });
  if (!found) throw new NotFoundError(target.kind);

  await db
    .insert(userStars)
    .values({
      id: nanoid(),
      userId: actor.userId,
      organizationId: actor.org.id,
      kind: target.kind,
      projectId: target.kind === "project" ? target.targetId : null,
      appId: target.kind === "app" ? target.targetId : null,
    })
    .onConflictDoNothing();
  return target;
}

/** Removes the actor's star. Unstarring what isn't starred is a no-op. */
export async function unstarTarget(actor: Actor, input: unknown): Promise<StarTarget> {
  authorize(actor, "org.view");
  const target = parseTarget(input);
  await db
    .delete(userStars)
    .where(
      and(
        eq(userStars.userId, actor.userId),
        eq(userStars.organizationId, actor.org.id),
        eq(userStars.kind, target.kind),
        eq(column(target.kind), target.targetId),
      ),
    );
  return target;
}
