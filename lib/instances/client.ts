// Browser helpers for linked instances.

import { toast } from "@/lib/messenger";
import type { DirectoryInstance, DirectoryResult, RemoteOrg } from "./directory";

export type ListedInstance = DirectoryInstance & { organizations: DirectoryResult<RemoteOrg[]> | null };

export type InstancesResponse = { local: { name: string }; instances: ListedInstance[] };

export async function fetchInstances(): Promise<InstancesResponse | null> {
  try {
    const res = await fetch("/api/v1/instances");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Signs in on `peerId` and goes there. Toasts and resolves false when it can't. */
export async function openOnInstance(
  peerId: string,
  opts: { next?: string; organizationId?: string } = {},
): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/instances/${encodeURIComponent(peerId)}/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || typeof json.url !== "string") {
      toast.error(json.error || "Couldn't sign in there");
      return false;
    }
    window.location.assign(json.url);
    return true;
  } catch {
    toast.error("Couldn't sign in there");
    return false;
  }
}
