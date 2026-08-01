// ---------------------------------------------------------------------------
// One-shot audit of stored compose configs.
//
// parseCompose auto-corrects config on the way to a deploy, but the stored YAML
// is what an operator reads and edits. This surfaces the misconfigurations that
// Docker accepts silently, before the app next starts.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { findNamedNetworkModes } from "./compose-validate";
import { logger } from "@/lib/logger";

const log = logger.child("compose-audit");

export type ComposeFinding = {
  appId: string;
  appName: string;
  service: string;
  networkMode: string;
};

/** Stored compose configs whose network_mode names a network, not a namespace. */
export async function auditStoredComposeConfigs(): Promise<ComposeFinding[]> {
  const rows = await db.query.apps.findMany({
    columns: { id: true, name: true, composeContent: true },
  });

  const findings: ComposeFinding[] = [];
  for (const app of rows) {
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

/** Run the audit and log what it finds. Never throws. */
export async function reportStoredComposeConfigs(): Promise<void> {
  try {
    const findings = await auditStoredComposeConfigs();
    if (findings.length === 0) return;

    // One warn line, not an error per service. parseCompose rewrites these on
    // the way to a deploy, so nothing is broken — only the stored YAML is stale.
    const services = findings.map((f) => `${f.appName}/${f.service}`).join(", ");
    log.warn(
      `${findings.length} stored compose service(s) use network_mode with a network name ` +
        `instead of networks: [...] — corrected at deploy, clear the stored YAML with ` +
        `scripts/migrate-network-mode.sql (${services})`,
    );
  } catch (err) {
    log.warn("Compose audit failed:", err);
  }
}
