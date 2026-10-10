import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitations, memberships } from "@/lib/db/schema";
import { isInstanceAdminUser } from "@/lib/auth/system-org";
import { getEmailProviderConfig } from "@/lib/system-settings";
import { authorize, requireFeature, type Actor } from "./actor";

export type Member = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  joinedAt: string;
};

export type Invitation = {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "expired";
  createdAt: string;
  expiresAt: string;
  inviter: { id: string; name: string | null; email: string } | null;
};

/** The org's members and their roles. */
export async function listMembers(actor: Actor): Promise<Member[]> {
  authorize(actor, "org.view");
  const rows = await db.query.memberships.findMany({
    where: eq(memberships.organizationId, actor.org.id),
    with: { user: { columns: { id: true, name: true, email: true, image: true } } },
  });
  return rows.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
    role: m.role,
    joinedAt: m.createdAt.toISOString(),
  }));
}

/** The org's invitations, newest first. */
export async function listInvitations(actor: Actor): Promise<Invitation[]> {
  authorize(actor, "org.view");
  await requireFeature("teams");
  const rows = await db.query.invitations.findMany({
    where: and(eq(invitations.targetId, actor.org.id), eq(invitations.scope, "org")),
    // Selected explicitly so the token hash is never serialized.
    columns: { id: true, email: true, role: true, status: true, createdAt: true, expiresAt: true },
    with: { inviter: { columns: { id: true, name: true, email: true } } },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return rows.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: inv.status as Invitation["status"],
    createdAt: inv.createdAt.toISOString(),
    expiresAt: inv.expiresAt.toISOString(),
    inviter: inv.inviter ?? null,
  }));
}

/** The team settings tab: members, and whether an instance admin is viewing the system org. */
export async function loadTeamTab(actor: Actor) {
  const members = await listMembers(actor);
  const systemOrg = actor.org.isSystemManaged;
  return { members, systemOrg, instanceAdmin: systemOrg && (await isInstanceAdminUser(actor.userId)) };
}

/** The invitations settings tab. */
export async function loadInvitationsTab(actor: Actor) {
  const [list, emailConfig] = await Promise.all([listInvitations(actor), getEmailProviderConfig()]);
  return { invitations: list, emailConfigured: !!emailConfig, systemOrg: actor.org.isSystemManaged };
}
