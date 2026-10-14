"use client";

import { useCallback, useState } from "react";
import { toast } from "@/lib/messenger";
import { activeDeploy } from "@/lib/ui/deploy-wait";

/** The app's running deploy, else its first queued one, read fresh. */
export async function activeDeployId(orgId: string, appId: string): Promise<string | undefined> {
  const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}`);
  if (!res.ok) return undefined;
  const { app } = await res.json();
  return activeDeploy<{ id: string; status: string }>(app.deployments ?? [])?.id;
}

/** Moves a deploy waiting in the deploy or build line to the front. Instance admins only. */
export function useBumpDeploy(orgId: string, appId: string) {
  const [bumping, setBumping] = useState(false);

  const bumpDeploy = useCallback(
    async (deploymentId?: string) => {
      setBumping(true);
      try {
        const targetId = deploymentId ?? (await activeDeployId(orgId, appId));
        if (!targetId) {
          toast.error("No queued deploy to move");
          return false;
        }
        const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/deployments/${targetId}/bump`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || "Couldn't move the deploy");
          return false;
        }
        toast.success("Moved to the front of the line");
        return true;
      } catch {
        toast.error("Couldn't move the deploy");
        return false;
      } finally {
        setBumping(false);
      }
    },
    [orgId, appId],
  );

  return { bumping, bumpDeploy };
}
