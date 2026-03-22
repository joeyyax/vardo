import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash, randomBytes } from "crypto";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// GET /api/v1/organizations/[orgId]/tokens
// List all API tokens for the current user in this org
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const tokens = await db.query.apiTokens.findMany({
      where: and(
        eq(apiTokens.userId, session.user.id),
        eq(apiTokens.organizationId, orgId)
      ),
      columns: {
        id: true,
        name: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        lastUsedAt: t.lastUsedAt?.toISOString() || null,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    return handleRouteError(error, "Error fetching tokens");
  }
}

// POST /api/v1/organizations/[orgId]/tokens
// Create a new API token
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Generate a random token
    const rawToken = `host_${randomBytes(32).toString("hex")}`;
    const tokenHash = hashToken(rawToken);

    await db.insert(apiTokens).values({
      id: nanoid(),
      userId: session.user.id,
      organizationId: orgId,
      name: name.trim(),
      tokenHash,
    });

    // Return the raw token only once
    return NextResponse.json({ token: rawToken }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating token");
  }
}

// DELETE /api/v1/organizations/[orgId]/tokens
// Delete an API token
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { id } = body;

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Token ID is required" }, { status: 400 });
    }

    // Ensure the token belongs to this user and org
    const token = await db.query.apiTokens.findFirst({
      where: and(
        eq(apiTokens.id, id),
        eq(apiTokens.userId, session.user.id),
        eq(apiTokens.organizationId, orgId)
      ),
    });

    if (!token) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    await db.delete(apiTokens).where(eq(apiTokens.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting token");
  }
}
