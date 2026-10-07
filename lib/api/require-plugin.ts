import { NextResponse } from "next/server";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";

/** Null when the feature is enabled, else a 404 Response. */
export async function requirePlugin(capability: FeatureFlag): Promise<NextResponse | null> {
  const available = await isFeatureEnabledAsync(capability);
  if (!available) {
    return NextResponse.json(
      { error: `Feature "${capability}" is not enabled.` },
      { status: 404 },
    );
  }
  return null;
}
