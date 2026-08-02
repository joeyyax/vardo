// ---------------------------------------------------------------------------
// One-shot audit of stored compose configs.
//
// parseCompose auto-corrects config on the way to a deploy, but the stored YAML
// is what an operator reads and edits. This surfaces the misconfigurations that
// Docker accepts silently, before the app next starts.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { findNamedNetworkModes, findMistypedSharedMarkers } from "./compose-validate";
import { SHARED_MARKER } from "./slot-partition";
import { logger } from "@/lib/logger";

const log = logger.child("compose-audit");

export type ComposeFinding = {
  appId: string;
  appName: string;
  service: string;
  networkMode: string;
};

export type SharedMarkerFinding = {
  appId: string;
  appName: string;
  service: string;
  value: unknown;
};

type ComposeRow = { id: string; name: string; composeContent: string | null };

async function storedComposeRows(): Promise<ComposeRow[]> {
  const rows = await db.query.apps.findMany({
    columns: { id: true, name: true, composeContent: true },
  });
  return rows.filter((r): r is ComposeRow => r.composeContent !== null);
}

/** Stored compose configs whose network_mode names a network, not a namespace. */
export async function auditStoredComposeConfigs(
  rows?: ComposeRow[],
): Promise<ComposeFinding[]> {
  const findings: ComposeFinding[] = [];
  for (const app of rows ?? (await storedComposeRows())) {
    if (!app.composeContent) continue;
    for (const hit of findNamedNetworkModes(app.composeContent)) {
      findings.push({
        appId: app.id,
        appName: app.name,
        service: hit.service,
        networkMode: hit.networkMode,
      });
    }
  }
  return findings;
}

/**
 * Stored compose configs with a non-boolean x-vardo-shared.
 * Those services are deployed blue/green despite the marker.
 */
export async function auditSharedMarkers(
  rows?: ComposeRow[],
): Promise<SharedMarkerFinding[]> {
  const findings: SharedMarkerFinding[] = [];
  for (const app of rows ?? (await storedComposeRows())) {
    if (!app.composeContent) continue;
    for (const hit of findMistypedSharedMarkers(app.composeContent)) {
      findings.push({
        appId: app.id,
        appName: app.name,
        service: hit.service,
        value: hit.value,
      });
    }
  }
  return findings;
}

/** Run the audit and log what it finds. Never throws. */
export async function reportStoredComposeConfigs(): Promise<void> {
  try {
    const rows = await storedComposeRows();

    const findings = await auditStoredComposeConfigs(rows);
    if (findings.length > 0) {
      // One warn line, not an error per service. parseCompose rewrites these on
      // the way to a deploy, so nothing is broken — only the stored YAML is stale.
      const services = findings.map((f) => `${f.appName}/${f.service}`).join(", ");
      log.warn(
        `${findings.length} stored compose service(s) use network_mode with a network name ` +
          `instead of networks: [...] — corrected at deploy, clear the stored YAML with ` +
          `scripts/migrate-network-mode.sql (${services})`,
      );
    }

    // Error, not warn: nothing corrects this later, and the service is one
    // deploy away from a second copy on its data directory.
    const mistyped = await auditSharedMarkers(rows);
    if (mistyped.length > 0) {
      const services = mistyped.map((f) => `${f.appName}/${f.service}`).join(", ");
      log.error(
        `${mistyped.length} stored compose service(s) set ${SHARED_MARKER} to a non-boolean — ` +
          `the marker is ignored and the service is deployed blue/green; ` +
          `edit the compose file and write it unquoted (${services})`,
      );
    }
  } catch (err) {
    log.warn("Compose audit failed:", err);
  }
}
