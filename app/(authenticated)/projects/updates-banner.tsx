"use client";

import { useEffect, useState } from "react";

export type UpdatesAggregate = {
  appsWithUpdates: { id: string; name: string; displayName: string; count: number }[];
  totalUpdates: number;
  unknownCount: number;
  cooldownUntil: string | null;
};

/** One fetch per page load, shared by the attention panel and the project cards. */
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
