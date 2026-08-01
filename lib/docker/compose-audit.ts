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

    log.error(
      `${findings.length} stored compose service(s) use network_mode with a network name, ` +
        `which Docker ignores — the service joins its project's default network instead:`,
    );
    for (const f of findings) {
      log.error(
        `  ${f.appName}/${f.service}: network_mode "${f.networkMode}" — should be networks: [${f.networkMode}]`,
      );
    }
  } catch (err) {
    log.warn("Compose audit failed:", err);
  }
}
