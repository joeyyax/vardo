"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, Package } from "lucide-react";

export type UpdatesAggregate = {
  appsWithUpdates: { id: string; name: string; displayName: string; count: number }[];
  totalUpdates: number;
  unknownCount: number;
  cooldownUntil: string | null;
};

/** One fetch per page load, shared by the banner and the project cards. */
export function useImageUpdates(orgId: string) {
  const [data, setData] = useState<UpdatesAggregate | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/image-updates`)
      .then((res) => (res.ok ? res.json() : null))
      .then((result) => !cancelled && setData(result))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return data;
}

/**
 * Org-wide roll-up. Deliberately achromatic — an available update is a fact,
 * not a fault, so it does not borrow the warning treatment.
 */
export function UpdatesBanner({ data }: { data: UpdatesAggregate | null }) {
  if (!data || data.appsWithUpdates.length === 0) return null;

  const appCount = data.appsWithUpdates.length;

  return (
    <details className="group squircle rounded-lg border bg-card text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-3 [&::-webkit-details-marker]:hidden">
        <Package className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">
          {data.totalUpdates} image update{data.totalUpdates === 1 ? "" : "s"} across {appCount}{" "}
          app{appCount === 1 ? "" : "s"}
        </span>
        <ChevronDown
          className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-2 border-t p-3">
        <div className="flex flex-wrap gap-1.5">
          {data.appsWithUpdates.map((app) => (
            <Link
              key={app.id}
              href={`/apps/${app.name}`}
              className="rounded-md bg-background/60 px-2 py-0.5 text-xs font-medium hover:bg-background transition-colors"
            >
              {app.displayName}
              {app.count > 1 && (
                <span className="ml-1 tabular-nums text-muted-foreground">{app.count}</span>
              )}
            </Link>
          ))}
        </div>
        <p className="text-muted-foreground">
          Open an app to review the proposed version and apply it.
          {data.unknownCount > 0 && ` ${data.unknownCount} image${data.unknownCount === 1 ? "" : "s"} could not be checked.`}
          {data.cooldownUntil &&
            ` Checks are paused until ${new Date(data.cooldownUntil).toLocaleTimeString()} after a registry rate limit.`}
        </p>
      </div>
    </details>
  );
}
