import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash, randomBytes } from "crypto";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const createTokenSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100).trim(),
    crossOrg: z.boolean().default(false),
  })
  .strict();
const deleteTokenSchema = z.object({ id: z.string().min(1, "Token ID is required") }).strict();
const updateTokenSchema = z
  .object({
    id: z.string().min(1, "Token ID is required"),
    crossOrg: z.boolean(),
  })
  .strict();

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
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const tokens = await db.query.apiTokens.findMany({
      where: and(
        eq(apiTokens.userId, org.session.user.id),
        eq(apiTokens.organizationId, orgId)
      ),
      columns: {
        id: true,
        name: true,
        crossOrg: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        crossOrg: t.crossOrg,
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
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = createTokenSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    // Generate a random token
    const rawToken = `vardo_${randomBytes(32).toString("hex")}`;
    const tokenHash = hashToken(rawToken);

    await db.insert(apiTokens).values({
      id: nanoid(),
      userId: org.session.user.id,
      organizationId: orgId,
      name: parsed.data.name,
      tokenHash,
      crossOrg: parsed.data.crossOrg,
    });

    // Return the raw token only once
    return NextResponse.json({ token: rawToken }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating token");
  }
}

// PATCH /api/v1/organizations/[orgId]/tokens
// Toggle cross-org scope on one of the caller's own tokens
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = updateTokenSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    // Scoped to the caller's own tokens — the flag can only ever reach orgs the
    // caller is already a member of, so no extra role check is warranted.
    const [updated] = await db
      .update(apiTokens)
      .set({ crossOrg: parsed.data.crossOrg })
      .where(
        and(
          eq(apiTokens.id, parsed.data.id),
          eq(apiTokens.userId, org.session.user.id),
          eq(apiTokens.organizationId, orgId)
        )
      )
      .returning({ id: apiTokens.id, crossOrg: apiTokens.crossOrg });

    if (!updated) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    return NextResponse.json({ token: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating token");
  }
}

// DELETE /api/v1/organizations/[orgId]/tokens
// Delete an API token
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = deleteTokenSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { id } = parsed.data;

    // Ensure the token belongs to this user and org
    const token = await db.query.apiTokens.findFirst({
      where: and(
        eq(apiTokens.id, id),
        eq(apiTokens.userId, org.session.user.id),
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

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-tokens" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-tokens" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-tokens" });
