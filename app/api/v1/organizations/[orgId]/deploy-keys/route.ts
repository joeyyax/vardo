import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { deployKeys } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateDeployKeypair } from "@/lib/crypto/ssh-keygen";
import { encrypt } from "@/lib/crypto/encrypt";
import { recordActivity } from "@/lib/activity";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const createKeySchema = z.object({ name: z.string().min(1, "Name is required").max(100).trim() }).strict();
const deleteKeySchema = z.object({ id: z.string().min(1, "Deploy key ID is required") }).strict();

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/deploy-keys
// Public keys only.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const keys = await db.query.deployKeys.findMany({
      where: eq(deployKeys.organizationId, orgId),
      columns: {
        id: true,
        name: true,
        publicKey: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      deployKeys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        publicKey: k.publicKey,
        createdAt: k.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    return handleRouteError(error, "Error fetching deploy keys");
  }
}

// POST /api/v1/organizations/[orgId]/deploy-keys
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.deployKeys.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }
    const { name } = parsed.data;

    const comment = `host/${name.trim()}`;
    const keypair = generateDeployKeypair(comment);

    const encryptedPrivateKey = encrypt(keypair.privateKey, orgId);

    const id = nanoid();
    await db.insert(deployKeys).values({
      id,
      organizationId: orgId,
      name: name.trim(),
      publicKey: keypair.publicKey,
      privateKey: encryptedPrivateKey,
    });

    recordActivity({
      organizationId: orgId,
      action: "deploy_key.created",
      userId: org.session.user.id,
      metadata: { deployKeyId: id, name: name.trim() },
    }).catch(() => {});

    return NextResponse.json(
      {
        id,
        name: name.trim(),
        publicKey: keypair.publicKey,
        createdAt: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    return handleRouteError(error, "Error creating deploy key");
  }
}

// DELETE /api/v1/organizations/[orgId]/deploy-keys
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.deployKeys.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = deleteKeySchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }
    const { id } = parsed.data;

    // Ensure the key belongs to this org
    const key = await db.query.deployKeys.findFirst({
      where: and(
        eq(deployKeys.id, id),
        eq(deployKeys.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!key) {
      return NextResponse.json({ error: "Deploy key not found" }, { status: 404 });
    }

    await db.delete(deployKeys).where(eq(deployKeys.id, id));

    recordActivity({
      organizationId: orgId,
      action: "deploy_key.deleted",
      userId: org.session.user.id,
      metadata: { deployKeyId: id, name: key.name },
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting deploy key");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-deploy-keys" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-deploy-keys" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/deploy-keys" });
