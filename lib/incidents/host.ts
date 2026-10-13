// Host process problems as level-triggered incidents: opened once while the condition holds, resolved when it clears.

import { and, desc, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { incidents } from "@/lib/db/schema";
import { incidentKey } from "./key";
import type { HostProblemKind } from "./system";
import type { IncidentSeverity } from "./types";

export type HostProblem = {
  kind: HostProblemKind;
  /** `host` for this instance, `peer:<instance id>` for a mesh peer. */
  about: string;
  title: string;
  message: string;
  severity: IncidentSeverity;
};

async function isOpen(kind: string, about: string): Promise<boolean> {
  const row = await db.query.incidents.findFirst({
    where: and(eq(incidents.key, incidentKey(kind, about)), eq(incidents.state, "open")),
    columns: { id: true },
  });
  return !!row;
}

/** Opens the incident when `active` and none is open; resolves an open one when not. Returns what it did. */
export async function syncHostProblem(problem: HostProblem, active: boolean, recovered: string): Promise<"opened" | "resolved" | "unchanged"> {
  const open = await isOpen(problem.kind, problem.about);
  if (active === open) return "unchanged";
  const [{ emitSystemIncident, resolveSystemIncident }, { adminOrgIds }] = await Promise.all([
    import("./system"),
    import("@/lib/notifications/admin-orgs"),
  ]);
  const orgIds = await adminOrgIds();
  if (active) {
    await emitSystemIncident(
      orgIds,
      { type: "system.service-down", title: problem.title, message: problem.message, service: problem.about, description: problem.title },
      { kind: problem.kind, about: problem.about, title: problem.title, severity: problem.severity },
    );
    return "opened";
  }
  await resolveSystemIncident(orgIds, problem.kind, problem.about, recovered);
  return "resolved";
}

export type OpenHostIncident = { key: string; kind: string; title: string; severity: string; openedAt: Date; updatedAt: Date };

/** Open `host.*` incidents, one per key. Each is recorded in every admin org, so they're collapsed. */
export async function listOpenHostIncidents(): Promise<OpenHostIncident[]> {
  const rows = await db
    .select({
      key: incidents.key,
      kind: incidents.kind,
      title: incidents.title,
      severity: incidents.severity,
      openedAt: incidents.openedAt,
      updatedAt: incidents.updatedAt,
    })
    .from(incidents)
    .where(and(eq(incidents.state, "open"), like(incidents.kind, "host.%")))
    .orderBy(desc(incidents.openedAt));
  return [...new Map(rows.map((r) => [r.key, r])).values()];
}
