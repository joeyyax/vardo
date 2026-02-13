import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  inboxItems,
  inboxItemFiles,
  projectExpenses,
  projectFiles,
  projects,
} from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

// POST /api/v1/organizations/[orgId]/inbox/[itemId]/convert
// Convert an inbox item into an expense
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

    // Fetch the inbox item with files
    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
      with: { files: true },
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
    const { description, amountCents, date, category, projectId, isBillable, vendor, status } = body;

    // Validate required fields
    if (!description || typeof description !== "string" || !description.trim()) {
      return NextResponse.json({ error: "Description is required" }, { status: 400 });
    }
    if (typeof amountCents !== "number" || amountCents <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Valid date (YYYY-MM-DD) is required" }, { status: 400 });
    }

    // If projectId is provided, verify it belongs to this org
    if (projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: {
          client: { columns: { organizationId: true } },
        },
      });

      if (!project || project.client.organizationId !== orgId) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
    }

    // Create a project file record for the first attachment (receipt)
    let receiptFileId: string | null = null;
    const firstFile = item.files[0];

    if (firstFile && projectId) {
      // Create a projectFiles record pointing to the same R2 key
      const [pf] = await db
        .insert(projectFiles)
        .values({
          projectId,
          uploadedBy: session.user.id,
          name: firstFile.name,
          sizeBytes: firstFile.sizeBytes,
          mimeType: firstFile.mimeType,
          r2Key: firstFile.r2Key,
          tags: ["receipt", "inbox"],
        })
        .returning();
      receiptFileId = pf.id;
    }

    // Create the expense
    const [expense] = await db
      .insert(projectExpenses)
      .values({
        organizationId: orgId,
        projectId: projectId || null,
        description: description.trim(),
        amountCents: Math.round(amountCents),
        date,
        category: category?.trim() || null,
        isBillable: isBillable === true,
        vendor: vendor?.trim() || null,
        status: status || "paid",
        source: "email",
        externalId: item.resendEmailId,
        receiptFileId,
        createdBy: session.user.id,
      })
      .returning();

    // Mark inbox item as converted
    await db
      .update(inboxItems)
      .set({
        status: "converted",
        convertedExpenseId: expense.id,
        updatedAt: new Date(),
      })
      .where(eq(inboxItems.id, itemId));

    return NextResponse.json({ expense, item: { id: itemId, status: "converted" } }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error converting inbox item:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
