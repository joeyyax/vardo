import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { encrypt, decrypt } from "@/lib/crypto/encrypt";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/env-vars
// Returns the decrypted env file content
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);
    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const reveal = request.nextUrl.searchParams.get("reveal") === "true";

    const record = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { envContent: true },
    });

    if (!record?.envContent) {
      return NextResponse.json({ content: "" });
    }

    if (!reveal) {
      // Return key names only, mask all values
      const decrypted = decrypt(record.envContent, orgId);
      const masked = decrypted
        .split("\n")
        .map((line) => {
          if (line.startsWith("#") || !line.includes("=")) return line;
          const key = line.slice(0, line.indexOf("="));
          return `${key}=••••••••`;
        })
        .join("\n");
      return NextResponse.json({ content: masked });
    }

    const content = decrypt(record.envContent, orgId);
    return NextResponse.json({ content });
  } catch (error) {
    return handleRouteError(error, "Error fetching env vars");
  }
}

const putSchema = z.object({
  content: z.string(),
});

// PUT /api/v1/organizations/[orgId]/apps/[appId]/env-vars
// Save the entire env file content (encrypted)
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);
    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const content = parsed.data.content;
    const encrypted = content.trim() ? encrypt(content, orgId) : null;

    await db
      .update(apps)
      .set({
        envContent: encrypted,
        needsRedeploy: true,
        updatedAt: new Date(),
      })
      .where(and(eq(apps.id, appId), eq(apps.organizationId, orgId)));

    return NextResponse.json({ saved: true });
  } catch (error) {
    return handleRouteError(error, "Error saving env vars");
  }
}
