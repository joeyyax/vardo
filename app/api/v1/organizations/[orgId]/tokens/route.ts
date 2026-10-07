import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { randomBytes } from "crypto";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { recordActivity } from "@/lib/activity";
import { hashApiToken, scopeCeilingViolation, type TokenScope } from "@/lib/auth/api-token";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const createTokenSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100).trim(),
    crossOrg: z.boolean().default(false),
    expiresAt: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .refine((d) => d.getTime() > Date.now(), "Expiry must be in the future")
      .nullable()
      .default(null),
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

/** The scope of the token making this request, or null for a cookie session. */
function callerScope(session: { authMethod: string; tokenScope?: TokenScope }): TokenScope | null {
  return session.authMethod === "token" ? (session.tokenScope ?? null) : null;
}

// GET /api/v1/organizations/[orgId]/tokens
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.tokens.manage");
    if (!org) return apiError.forbidden();

    const tokens = await db.query.apiTokens.findMany({
      where: and(
        eq(apiTokens.userId, org.session.user.id),
        eq(apiTokens.organizationId, orgId)
      ),
      columns: {
        id: true,
        name: true,
        crossOrg: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        crossOrg: t.crossOrg,
        expiresAt: t.expiresAt?.toISOString() || null,
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
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.tokens.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = createTokenSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const violation = scopeCeilingViolation({
      caller: callerScope(org.session),
      requested: parsed.data,
    });
    if (violation) return NextResponse.json({ error: violation }, { status: 403 });

    const rawToken = `vardo_${randomBytes(32).toString("hex")}`;
    const tokenHash = hashApiToken(rawToken);

    const tokenId = nanoid();
    await db.insert(apiTokens).values({
      id: tokenId,
      userId: org.session.user.id,
      organizationId: orgId,
      name: parsed.data.name,
      tokenHash,
      crossOrg: parsed.data.crossOrg,
      expiresAt: parsed.data.expiresAt,
    });

    recordActivity({
      organizationId: orgId,
      action: "token.created",
      userId: org.session.user.id,
      metadata: { tokenId, name: parsed.data.name, crossOrg: parsed.data.crossOrg },
    }).catch(() => {});

    // The raw token is returned only once.
    return NextResponse.json({ token: rawToken }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating token");
  }
}

// PATCH /api/v1/organizations/[orgId]/tokens
// Change the scope of one of the caller's own tokens
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.tokens.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = updateTokenSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const { id, ...requested } = parsed.data;
    const violation = scopeCeilingViolation({
      caller: callerScope(org.session),
      requested,
    });
    if (violation) return NextResponse.json({ error: violation }, { status: 403 });

    const [updated] = await db
      .update(apiTokens)
      .set(requested)
      .where(
        and(
          eq(apiTokens.id, id),
          eq(apiTokens.userId, org.session.user.id),
          eq(apiTokens.organizationId, orgId)
        )
      )
      .returning({
        id: apiTokens.id,
        crossOrg: apiTokens.crossOrg,
      });

    if (!updated) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    return NextResponse.json({ token: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating token");
  }
}

// DELETE /api/v1/organizations/[orgId]/tokens
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("api-tokens");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.tokens.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = deleteTokenSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
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
