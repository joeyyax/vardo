import { redirect } from "next/navigation";
import { and, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { filtersToQuery, parseFilters } from "@/lib/activity/filter";
import {
  activityConditions,
  activityFacets,
  countActivities,
} from "@/lib/activity/query";
import { ActivityFeed } from "./activity-feed";

const PAGE_SIZE = 50;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ActivityPage({ searchParams }: PageProps) {
  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  const orgId = (orgData.organization as { id: string }).id;
  const filters = parseFilters(await searchParams);
  const scope = { orgId };

  const [rows, facets, total] = await Promise.all([
    db.query.activities.findMany({
      where: and(...activityConditions(scope, filters)),
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
        app: { columns: { id: true, name: true, displayName: true } },
      },
      orderBy: [desc(activities.createdAt)],
      limit: PAGE_SIZE,
    }),
    activityFacets(scope, filters.since),
    countActivities(scope, filters),
  ]);

  return (
    // Rows accumulated by "load more" belong to the filters that fetched them,
    // so a filter change starts a new list rather than appending to the old one.
    <ActivityFeed
      key={filtersToQuery(filters)}
      rows={rows}
      orgId={orgId}
      filters={filters}
      facets={facets}
      total={total}
    />
  );
}
