"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/messenger";
import type { SlotStatus } from "../types";

/**
 * Cancels the running or queued deploy. The engine stops after the phase it is
 * in, so a running deploy reports "cancelling" rather than a finished cancel.
 */
export function useCancelDeploy(orgId: string, appId: string) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);

  const cancelDeploy = useCallback(
    async (deploymentId?: string) => {
      setCancelling(true);
      try {
        let targetId = deploymentId;
        if (!targetId) {
          const appRes = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}`);
          if (appRes.ok) {
            const { app: appData } = await appRes.json();
            const active = appData.deployments?.find(
              (d: { status: string }) => d.status === "running" || d.status === "queued",
            );
            targetId = active?.id;
          }
        }
        if (!targetId) {
          toast.error("No active deployment to cancel");
          return false;
        }

        const res = await fetch(
          `/api/v1/organizations/${orgId}/apps/${appId}/deployments/${targetId}`,
          { method: "DELETE" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || "Failed to cancel deployment");
          return false;
        }

        if (data.cancelling) {
          setCancelRequested(true);
          toast.info("Cancelling — the deploy will stop after the current phase");
        } else {
          toast.success("Deployment cancelled");
        }
        return true;
      } catch {
        toast.error("Failed to cancel deployment");
        return false;
      } finally {
        setCancelling(false);
      }
    },
    [orgId, appId],
  );

  return { cancelling, cancelRequested, setCancelRequested, cancelDeploy };
}

/**
 * Blue/green slot state for the app. Refetched whenever `refreshKey` changes,
 * because a deploy replaces the standby.
 */
export function useSlotStatus(
  orgId: string,
  appId: string,
  { enabled = true, refreshKey }: { enabled?: boolean; refreshKey?: unknown } = {},
) {
  const [slotStatus, setSlotStatus] = useState<SlotStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/apps/${appId}/slot-status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SlotStatus | null) => {
        if (!cancelled && data) setSlotStatus(data);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [orgId, appId, enabled, refreshKey]);

  return slotStatus;
}
