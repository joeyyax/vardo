import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, INBOX_ITEM_STATUSES, type InboxItemStatus, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc, inArray, or } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/inbox
// List inbox items with files
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const clientId = searchParams.get("clientId");
    const projectId = searchParams.get("projectId");
    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : undefined;
    const limit = parsedLimit && !isNaN(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

    const whereConditions = [eq(inboxItems.organizationId, orgId)];

    if (status && INBOX_ITEM_STATUSES.includes(status as InboxItemStatus)) {
      whereConditions.push(eq(inboxItems.status, status as InboxItemStatus));
    }

    if (projectId) {
      whereConditions.push(eq(inboxItems.projectId, projectId));
    } else if (clientId) {
      // Trickle-up: items scoped to the client OR any of its projects
      const clientProjects = await db.query.projects.findMany({
        where: eq(projects.clientId, clientId),
        columns: { id: true },
      });
      const projectIds = clientProjects.map((p) => p.id);

      if (projectIds.length > 0) {
        whereConditions.push(
          or(
            eq(inboxItems.clientId, clientId),
            inArray(inboxItems.projectId, projectIds)
          )!
        );
      } else {
        whereConditions.push(eq(inboxItems.clientId, clientId));
      }
    }

    const items = await db.query.inboxItems.findMany({
      where: and(...whereConditions),
      orderBy: [desc(inboxItems.receivedAt)],
      limit: limit,
      with: {
        files: true,
        convertedExpense: {
          columns: {
            id: true,
            description: true,
            amountCents: true,
          },
        },
        client: {
          columns: { id: true, name: true },
        },
        project: {
          columns: { id: true, name: true },
        },
      },
    });

    // When limit is applied, the filtered count from items may be incomplete
    // Always compute from the full filtered result for badge accuracy
    let needsReviewCount: number;
    if (limit) {
      const countItems = await db.query.inboxItems.findMany({
        where: and(
          ...whereConditions.filter((c) => c !== undefined),
          eq(inboxItems.status, "needs_review" as InboxItemStatus)
        ),
        columns: { id: true },
      });
      needsReviewCount = countItems.length;
    } else {
      needsReviewCount = items.filter((i) => i.status === "needs_review").length;
    }

    return NextResponse.json({ items, needsReviewCount });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching inbox items:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
