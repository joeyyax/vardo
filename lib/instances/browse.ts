// Answering side of a browse request: the user with the same verified email sees what their own memberships allow.

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { deployments, memberships, projects, user } from "@/lib/db/schema";
import { can } from "@/lib/auth/permissions";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { VERIFY_EMAIL_HINT } from "@/lib/auth/verify-email-paths";
import type { RemoteApp, RemoteOrg, RemoteProject } from "./directory";

export const INSTANCE_BROWSE_PATH = "/api/v1/mesh/instance-browse";

export const browseRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organizations"), email: z.string().email().max(320) }).strict(),
  z
    .object({ kind: z.literal("projects"), email: z.string().email().max(320), organizationId: z.string().min(1).max(128) })
    .strict(),
]);

export type BrowseRequest = z.infer<typeof browseRequestSchema>;

export type BrowsePeer = { name: string; acceptInstanceBrowse: boolean; organizationId: string | null };

export class BrowseError extends Error {
  constructor(
    message: string,
    public status: 403 | 404,
  ) {
    super(message);
    this.name = "BrowseError";
  }
}

export type AppRow = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  parked: boolean;
  domains: { domain: string }[];
  deployments: { status: string; startedAt: Date; finishedAt: Date | null }[];
};

export type ProjectRow = { id: string; name: string; displayName: string; apps: AppRow[] };

export type MembershipRow = { role: string; organization: { id: string; name: string; isSystemManaged: boolean } };

/** Reads browse needs. Swapped out in tests. */
export type BrowseStore = {
  verifiedUserId(email: string): Promise<string | null>;
  memberships(userId: string): Promise<MembershipRow[]>;
  projectsIn(organizationId: string): Promise<ProjectRow[]>;
};

export const dbBrowseStore: BrowseStore = {
  async verifiedUserId(email) {
    const row = await db.query.user.findFirst({
      where: sql`lower(${user.email}) = ${email.toLowerCase()}`,
      columns: { id: true, emailVerified: true },
    });
    return row?.emailVerified ? row.id : null;
  },
  async memberships(userId) {
    return db.query.memberships.findMany({
      where: eq(memberships.userId, userId),
      columns: { role: true },
      with: { organization: { columns: { id: true, name: true, isSystemManaged: true } } },
    });
  },
  async projectsIn(organizationId) {
    return db.query.projects.findMany({
      where: and(eq(projects.organizationId, organizationId), eq(projects.isSystemManaged, false)),
      columns: { id: true, name: true, displayName: true },
      orderBy: (p, { asc }) => [asc(p.displayName)],
      with: {
        apps: {
          columns: { id: true, name: true, displayName: true, status: true, parked: true },
          orderBy: (a, { asc }) => [asc(a.displayName)],
          with: {
            domains: { columns: { domain: true } },
            deployments: {
              columns: { status: true, startedAt: true, finishedAt: true },
              orderBy: [desc(deployments.startedAt)],
              limit: 1,
            },
          },
        },
      },
    });
  },
};

const STATUS_ATTENTION: Record<string, string> = {
  error: "Container failed",
  missing: "No container on the host",
};

/** The one thing to look at on an app, or null. */
export function appAttention(app: Pick<AppRow, "status" | "parked" | "deployments">): string | null {
  if (app.parked) return null;
  if (STATUS_ATTENTION[app.status]) return STATUS_ATTENTION[app.status];
  if (app.deployments[0]?.status === "failed") return "Last deploy failed";
  return null;
}

/** An app as it may leave this instance. Built field by field; nothing else is copied. */
export function toRemoteApp(app: AppRow): RemoteApp {
  const last = app.deployments[0];
  return {
    id: app.id,
    name: app.name,
    displayName: app.displayName,
    status: app.status,
    domains: [...new Set(app.domains.map((d) => d.domain))].slice(0, 50),
    lastDeployedAt: last ? (last.finishedAt ?? last.startedAt).toISOString() : null,
    attention: appAttention(app),
  };
}

export function toRemoteProject(project: ProjectRow): RemoteProject {
  return {
    id: project.id,
    name: project.name,
    displayName: project.displayName,
    apps: project.apps.map(toRemoteApp),
  };
}

/** Orgs the user may browse from `peer`: their own memberships, system orgs left out, narrowed to the peer's bound org. */
function visibleOrgs(rows: MembershipRow[], peer: BrowsePeer): RemoteOrg[] {
  return rows
    .filter((m) => !m.organization.isSystemManaged)
    .filter((m) => !peer.organizationId || m.organization.id === peer.organizationId)
    .filter((m) => can(m, "app.view"))
    .map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role }));
}

/** Answers `request` for `peer`. The caller has checked the mesh signature and nonce. */
export async function browse(
  peer: BrowsePeer,
  request: BrowseRequest,
  store: BrowseStore = dbBrowseStore,
): Promise<{ organizations: RemoteOrg[] } | { projects: RemoteProject[] }> {
  const here = (await getInstanceDisplayName()) ?? "this instance";
  if (!peer.acceptInstanceBrowse) {
    throw new BrowseError(`${here} doesn't share its projects with ${peer.name}. An admin there can turn it on.`, 403);
  }

  const userId = await store.verifiedUserId(request.email);
  if (!userId) throw new BrowseError(`No user with that verified email on ${here}. ${VERIFY_EMAIL_HINT} there.`, 403);

  const orgs = visibleOrgs(await store.memberships(userId), peer);
  if (request.kind === "organizations") return { organizations: orgs };

  const org = orgs.find((o) => o.id === request.organizationId);
  if (!org) throw new BrowseError(`That organization isn't one of yours on ${here}.`, 404);

  return { projects: (await store.projectsIn(org.id)).map(toRemoteProject) };
}
