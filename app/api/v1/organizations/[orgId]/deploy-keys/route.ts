import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { deployKeys } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateDeployKeypair } from "@/lib/crypto/ssh-keygen";
import { encrypt, decrypt } from "@/lib/crypto/encrypt";
import { recordActivity } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/deploy-keys
// List all deploy keys for this org (public keys only -- never expose private keys)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
// Generate a new SSH deploy key
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

    if (name.trim().length > 100) {
      return NextResponse.json({ error: "Name must be 100 characters or less" }, { status: 400 });
    }

    // Generate Ed25519 keypair
    const comment = `host/${name.trim()}`;
    const keypair = generateDeployKeypair(comment);

    // Encrypt the private key before storage
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
      userId: session.user.id,
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
// Delete a deploy key
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
      return NextResponse.json({ error: "Deploy key ID is required" }, { status: 400 });
    }

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
      userId: session.user.id,
      metadata: { deployKeyId: id, name: key.name },
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting deploy key");
  }
}
