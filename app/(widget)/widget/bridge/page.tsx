import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scopeClients, memberships, projectInvitations, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { BridgeClient } from "./bridge-client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ token?: string; projectId?: string }>;

const UNAUTHED = { type: "scope-auth" as const, authenticated: false as const };

export default async function BridgePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const token = params.token;
  const legacyProjectId = params.projectId;

  // --- Token-based auth (new) ---
  if (token) {
    const sc = await db.query.scopeClients.findFirst({
      where: eq(scopeClients.token, token),
      with: {
        client: { columns: { id: true, organizationId: true } },
        defaultProject: { columns: { id: true, name: true, isArchived: true, stage: true } },
      },
    });

    if (!sc || !sc.enabled) {
      return <BridgeClient auth={UNAUTHED} />;
    }

    // Don't load widget for archived or completed default projects
    if (sc.defaultProject?.isArchived || sc.defaultProject?.stage === "completed" || sc.defaultProject?.stage === "offboarding") {
      return <BridgeClient auth={UNAUTHED} />;
    }

    const orgId = sc.client.organizationId;

    // Check access based on publicAccess flag
    if (!sc.publicAccess) {
      // Require authenticated session + org membership or project invitation
      const session = await getSession();
      if (!session?.user?.id) {
        return <BridgeClient auth={UNAUTHED} />;
      }

      const [membership, invitation] = await Promise.all([
        db.query.memberships.findFirst({
          where: and(
            eq(memberships.userId, session.user.id),
            eq(memberships.organizationId, orgId)
          ),
        }),
        sc.defaultProjectId
          ? db.query.projectInvitations.findFirst({
              where: and(
                eq(projectInvitations.projectId, sc.defaultProjectId),
                eq(projectInvitations.userId, session.user.id)
              ),
            })
          : null,
      ]);

      if (!membership && !invitation) {
        return <BridgeClient auth={UNAUTHED} />;
      }

      return (
        <BridgeClient
          auth={{
            type: "scope-auth",
            authenticated: true,
            user: {
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
            },
            scopeClientId: sc.id,
            organizationId: orgId,
            clientId: sc.clientId,
            defaultProjectId: sc.defaultProjectId || undefined,
            publicAccess: false,
          }}
        />
      );
    }

    // Public access — session optional
    const session = await getSession();
    return (
      <BridgeClient
        auth={{
          type: "scope-auth",
          authenticated: true,
          user: session?.user
            ? {
                id: session.user.id,
                name: session.user.name,
                email: session.user.email,
              }
            : undefined,
          scopeClientId: sc.id,
          organizationId: orgId,
          clientId: sc.clientId,
          defaultProjectId: sc.defaultProjectId || undefined,
          publicAccess: true,
        }}
      />
    );
  }

  // --- Legacy project-based auth (backward compat for data-project script tags) ---
  if (legacyProjectId) {
    const session = await getSession();
    if (!session?.user?.id) {
      return <BridgeClient auth={UNAUTHED} />;
    }

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, legacyProjectId),
      with: {
        client: { columns: { id: true, organizationId: true } },
      },
    });

    if (!project?.client) {
      return <BridgeClient auth={UNAUTHED} />;
    }

    if (project.isArchived || project.stage === "completed" || project.stage === "offboarding") {
      return <BridgeClient auth={UNAUTHED} />;
    }

    const orgId = project.client.organizationId;

    const [membership, invitation] = await Promise.all([
      db.query.memberships.findFirst({
        where: and(
          eq(memberships.userId, session.user.id),
          eq(memberships.organizationId, orgId)
        ),
      }),
      db.query.projectInvitations.findFirst({
        where: and(
          eq(projectInvitations.projectId, legacyProjectId),
          eq(projectInvitations.userId, session.user.id)
        ),
      }),
    ]);

    if (!membership && !invitation) {
      return <BridgeClient auth={UNAUTHED} />;
    }

    return (
      <BridgeClient
        auth={{
          type: "scope-auth",
          authenticated: true,
          user: {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
          },
          scopeClientId: undefined,
          organizationId: orgId,
          clientId: project.client.id,
          defaultProjectId: legacyProjectId,
          publicAccess: false,
        }}
      />
    );
  }

  return <BridgeClient auth={UNAUTHED} />;
}
