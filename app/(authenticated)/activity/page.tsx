import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadActivityPage } from "@/lib/app-services/activity";
import { filtersToQuery, parseFilters } from "@/lib/activity/filter";
import { ActivityFeed } from "./activity-feed";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ActivityPage({ searchParams }: PageProps) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const filters = parseFilters(await searchParams);
  const { rows, facets, total } = await pageData(loadActivityPage(actor, filters));

  return (
    // A filter change starts a new list.
    <ActivityFeed
      key={filtersToQuery(filters)}
      rows={rows}
      orgId={actor.org.id}
      filters={filters}
      facets={facets}
      total={total}
    />
  );
}
