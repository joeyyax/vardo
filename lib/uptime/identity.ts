// How this instance's vantage point introduces itself to linked peers.

import { getInstanceId } from "@/lib/constants";
import { findProvider, locationLabel } from "@/lib/trust/hosting";
import { effectiveHosting, getTrustSettings, providerLabel } from "@/lib/trust/store";
import { getInstanceDisplayName } from "@/lib/system-settings";
import type { VantageIdentity } from "./link";
import { ensureLocalVantage } from "./vantage";

/** Provider and region when Vardo knows them, else null. */
async function hostingLabel(): Promise<string | null> {
  try {
    const hosting = effectiveHosting(await getTrustSettings());
    if (!hosting) return null;
    const where = locationLabel(findProvider(hosting.provider), hosting);
    return [providerLabel(hosting), where].filter(Boolean).join(" · ");
  } catch {
    return null;
  }
}

export async function localIdentity(): Promise<VantageIdentity> {
  const [id, name, location, local] = await Promise.all([
    getInstanceId(),
    getInstanceDisplayName().catch(() => null),
    hostingLabel(),
    ensureLocalVantage(),
  ]);
  return { id, name: name || "Vardo", location, publicKey: local.publicKey };
}
