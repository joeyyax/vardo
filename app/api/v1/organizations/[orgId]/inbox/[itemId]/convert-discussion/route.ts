import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  inboxItems,
  projectComments,
  clientComments,
  projects,
  clients,
} from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

// POST /api/v1/organizations/[orgId]/inbox/[itemId]/convert-discussion
// Convert an inbox item into a discussion comment on a project or client
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch the inbox item
    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (item.status === "converted") {
      return NextResponse.json(
        { error: "Item has already been converted" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const resolvedProjectId = body.projectId || item.projectId;
    const resolvedClientId = body.clientId || item.clientId;

    let comment;

    if (resolvedProjectId) {
      // Verify the project belongs to this org
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, resolvedProjectId),
        with: {
          client: { columns: { organizationId: true } },
        },
      });

      if (!project || project.client.organizationId !== orgId) {
        return NextResponse.json(
          { error: "Project not found" },
          { status: 404 }
        );
      }

      [comment] = await db
        .insert(projectComments)
        .values({
          projectId: resolvedProjectId,
          authorId: session.user.id,
          content: content.trim(),
        })
        .returning();
    } else if (resolvedClientId) {
      // Verify the client belongs to this org
      const client = await db.query.clients.findFirst({
        where: and(
          eq(clients.id, resolvedClientId),
          eq(clients.organizationId, orgId)
        ),
      });

      if (!client) {
        return NextResponse.json(
          { error: "Client not found" },
          { status: 404 }
        );
      }

      [comment] = await db
        .insert(clientComments)
        .values({
          clientId: resolvedClientId,
          authorId: session.user.id,
          content: content.trim(),
        })
        .returning();
    } else {
      return NextResponse.json(
        { error: "A project or client is required" },
        { status: 400 }
      );
    }

    // Mark inbox item as converted
    await db
      .update(inboxItems)
      .set({
        status: "converted",
        convertedTo: "discussion",
        updatedAt: new Date(),
      })
      .where(eq(inboxItems.id, itemId));

    return NextResponse.json(
      { comment, item: { id: itemId, status: "converted" } },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error converting inbox item to discussion:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
