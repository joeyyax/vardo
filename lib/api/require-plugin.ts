// ---------------------------------------------------------------------------
// Feature gate — middleware for API routes
//
// Returns a 404 if the required feature is not enabled via feature flags.
// Use this in route handlers that belong to a gated feature.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";

/**
 * Check if a feature is enabled. Returns null if enabled,
 * or a 404 Response if the feature is disabled.
 *
 * Usage in route handlers:
 * ```ts
 * const gate = await requirePlugin("backups");
 * if (gate) return gate;
 * // ... rest of handler
 * ```
 */
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
