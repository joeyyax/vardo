import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { formatDistanceToNowStrict } from "date-fns";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getCooldownUntil } from "@/lib/docker/image-updates/check";
import { getAggregateUpdateStatus } from "@/lib/docker/image-updates/status";
import { conditionRows, type AttentionRow } from "@/lib/ui/attention";
import { getVersionData } from "@/lib/version";
import { getFleetAttention } from "./fleet";

type BuildOptions = {
  /** Release availability is admin business — non-admins never see the row. */
  isAppAdmin: boolean;
};

/**
 * Every notice the instance has, in one list. The chrome renders this on every
 * page, so it is built here rather than assembled per route.
 */
export async function buildAttentionRows(
  orgId: string,
  { isAppAdmin }: BuildOptions,
): Promise<AttentionRow[]> {
  // Parents own the compose; including children would double-count updates.
  const appRows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      status: apps.status,
      conditions: apps.conditions,
      containerMemoryLimit: apps.containerMemoryLimit,
      deployType: apps.deployType,
      imageName: apps.imageName,
      composeContent: apps.composeContent,
      composeService: apps.composeService,
    })
    .from(apps)
    .where(and(eq(apps.organizationId, orgId), isNull(apps.parentAppId)));

  const [fleet, updates, version] = await Promise.all([
    getFleetAttention(orgId),
    getCooldownUntil().then((cooldown) => getAggregateUpdateStatus(appRows, cooldown)),
    isAppAdmin ? getVersionData().catch(() => null) : null,
  ]);

  const rows = conditionRows(appRows);

  if (fleet.servicesDown.length > 0) {
    rows.push({
      key: "service-down",
      label: "Service down",
      tone: "error",
      items: fleet.servicesDown.map((s) => ({
        id: s.id,
        name: s.name,
        href: "/admin",
        detail: `Last alert ${formatDistanceToNowStrict(new Date(s.lastFired))} ago`,
      })),
      footer: "Platform services Vardo depends on. Check the admin overview for reachability.",
    });
  }

  if (fleet.unreachableDomains.length > 0) {
    rows.push({
      key: "domain-unreachable",
      label: "Domain unreachable",
      tone: "error",
      items: fleet.unreachableDomains.map((d) => ({
        id: d.id,
        name: d.domain,
        href: d.appName ? `/apps/${d.appName}/networking` : "/settings/domains",
        detail: d.error ?? undefined,
      })),
      footer: "The last check for these domains failed.",
    });
  }

  // Containers running with no cgroup memory limit can take the whole host, and
  // a JVM in one sizes its heap from the hypervisor's RAM, not the guest's.
  const unlimited = appRows.filter(
    (a) => a.status === "active" && a.containerMemoryLimit === 0,
  );
  if (unlimited.length > 0) {
    rows.push({
      key: "no-memory-limit",
      label: "No memory limit",
      tone: "warning",
      items: unlimited.map((a) => ({
        id: a.id,
        name: a.displayName,
        href: `/apps/${a.name}`,
      })),
      footer:
        "Redeploy to apply the priority tier default, or set a limit in each app's settings.",
    });
  }

  if (updates.appsWithUpdates.length > 0) {
    const notes = ["Open an app to review the proposed version and apply it."];
    if (updates.unknownCount > 0) {
      notes.push(
        `${updates.unknownCount} image${updates.unknownCount === 1 ? "" : "s"} could not be checked.`,
      );
    }
    if (updates.cooldownUntil) {
      notes.push(
        `Checks are paused until ${new Date(updates.cooldownUntil).toLocaleTimeString()} after a registry rate limit.`,
      );
    }
    rows.push({
      key: "image-updates",
      label: "Image updates",
      tone: "neutral",
      items: updates.appsWithUpdates.map((a) => ({
        id: a.id,
        name: a.displayName,
        href: `/apps/${a.name}/updates`,
        detail: `${a.count} image${a.count === 1 ? "" : "s"}`,
      })),
      footer: notes.join(" "),
    });
  }

  if (version?.hasUpdate) {
    rows.push({
      key: "vardo-update",
      label: "Vardo update",
      tone: "neutral",
      items: [
        {
          id: version.latestVersion,
          name: `Vardo ${version.latestVersion}`,
          href: version.releaseUrl,
          detail: `You are on ${version.currentVersion}`,
          external: true,
        },
      ],
      footer: "Release notes open on GitHub.",
    });
  }

  return rows;
}
