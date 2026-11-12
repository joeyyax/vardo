"use client";

import { useCallback } from "react";
import { toast } from "@/lib/messenger";
import { activeDeployId } from "./use-bump-deploy";

/** Starts a deploy held for power while the host is on battery. Instance admins only. */
export function useDeployAnyway(orgId: string, appId: string) {
  const deployAnyway = useCallback(
    async (deploymentId?: string) => {
      try {
        const targetId = deploymentId ?? (await activeDeployId(orgId, appId));
        if (!targetId) {
          toast.error("No held deploy to start");
          return false;
        }
        const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/deployments/${targetId}/deploy-anyway`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || "Couldn't start the deploy");
          return false;
        }
        toast.success("Deploying on battery");
        return true;
      } catch {
        toast.error("Couldn't start the deploy");
        return false;
      }
    },
    [orgId, appId],
  );

  return { deployAnyway };
}
