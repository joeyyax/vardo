import { redirect } from "next/navigation";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { parseFilters, hasActiveFilters } from "@/lib/activity/filter";
import { ActivityFeed } from "./activity-feed";

/** Rows fetched for an unfiltered first paint. */
const PAGE_SIZE = 50;

/**
 * Rows scanned when a filter is on. Family and outcome are derived from the
 * action string rather than stored, so narrowing happens after the fetch.
 */
const SCAN_LIMIT = 500;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ActivityPage({ searchParams }: PageProps) {
  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  const orgId = (orgData.organization as { id: string }).id;
  const filters = parseFilters(await searchParams);
  const limit = hasActiveFilters(filters) ? SCAN_LIMIT : PAGE_SIZE;

  const scope = filters.since
    ? and(
        eq(activities.organizationId, orgId),
        gte(activities.createdAt, filters.since)
      )
    : eq(activities.organizationId, orgId);

  const rows = await db.query.activities.findMany({
    where: scope,
    with: {
      user: { columns: { id: true, name: true, email: true, image: true } },
      app: { columns: { id: true, name: true, displayName: true } },
    },
    orderBy: [desc(activities.createdAt)],
    limit,
  });

  return (
    <ActivityFeed
      rows={rows}
      orgId={orgId}
      filters={filters}
      loadedAll={rows.length < limit}
    />
  );
}
