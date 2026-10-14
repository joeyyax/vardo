"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/messenger";
import { activeDeploy } from "@/lib/ui/deploy-wait";
import type { SlotStatus } from "../types";

/** The app's running deploy, else its first queued one, read fresh. */
async function activeDeployId(orgId: string, appId: string): Promise<string | undefined> {
  const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}`);
  if (!res.ok) return undefined;
  const { app } = await res.json();
  return activeDeploy<{ id: string; status: string }>(app.deployments ?? [])?.id;
}

/** Cancels the running or queued deploy. A running deploy reports "cancelling" until its phase ends. */
export function useCancelDeploy(orgId: string, appId: string) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);

  const cancelDeploy = useCallback(
    async (deploymentId?: string) => {
      setCancelling(true);
      try {
        const targetId = deploymentId ?? (await activeDeployId(orgId, appId));
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
          toast.error(data.error || "Couldn't cancel deployment");
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
        toast.error("Couldn't cancel deployment");
        return false;
      } finally {
        setCancelling(false);
      }
    },
    [orgId, appId],
  );

  return { cancelling, cancelRequested, setCancelRequested, cancelDeploy };
}

/** Moves the app's queued or build-held deploy to the front of its line. Instance admins only. */
export function useBumpDeploy(orgId: string, appId: string) {
  const [bumping, setBumping] = useState(false);

  const bumpDeploy = useCallback(
    async () => {
      setBumping(true);
      try {
        const targetId = await activeDeployId(orgId, appId);
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

/** Blue/green slot state, refetched when `refreshKey` changes. */
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
