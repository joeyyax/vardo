// ---------------------------------------------------------------------------
// Plugin capability gate — middleware for API routes
//
// Returns a 404 if the required plugin capability is not enabled.
// Use this in route handlers that belong to a plugin feature.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { isCapabilityAvailable } from "@/lib/plugins/registry";

/**
 * Check if a plugin capability is available. Returns null if enabled,
 * or a 404 Response if the plugin is disabled.
 *
 * Usage in route handlers:
 * ```ts
 * const gate = await requirePlugin("backups");
 * if (gate) return gate;
 * // ... rest of handler
 * ```
 */
export async function requirePlugin(capability: string): Promise<NextResponse | null> {
  const available = await isCapabilityAvailable(capability);
  if (!available) {
    return NextResponse.json(
      { error: `Feature "${capability}" is not enabled. Enable the plugin in admin settings.` },
      { status: 404 },
    );
  }
  return null;
}
