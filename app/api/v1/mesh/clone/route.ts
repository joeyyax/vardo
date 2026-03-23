import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { importProjectBundle } from "@/lib/mesh/transfers";
import { projectBundleSchema } from "@/lib/mesh/bundle-schema";
import type { ProjectBundle } from "@/lib/mesh/transfers";

const cloneSchema = z.object({
  bundle: projectBundleSchema.extend({
    transferType: z.literal("clone"),
  }),
  orgId: z.string().min(1),
});

/**
 * POST /api/v1/mesh/clone — receive a project bundle as a fresh clone.
 *
 * Creates a new independent deployment with unique names. No env vars
 * are carried over — the clone starts fresh.
 */
export async function POST(request: NextRequest) {
  try {
    await requireMeshPeer(request);

    const body = await request.json();
    const parsed = cloneSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid bundle", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { bundle, orgId } = parsed.data;

    const result = await importProjectBundle(
      orgId,
      bundle as ProjectBundle,
      "development"
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error receiving clone");
  }
}
