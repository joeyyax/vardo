import { defaultTrackMode, type TrackMode } from "@/lib/docker/image-updates/track-policy";

/** Saves a track policy. Picking the image's default clears the row instead. */
export async function saveTrack(
  orgId: string,
  target: { appId: string; service: string | null; image: string },
  mode: TrackMode,
): Promise<void> {
  const reset = mode === defaultTrackMode(target.image);
  const res = await fetch(`/api/v1/organizations/${orgId}/image-updates/tracks`, {
    method: reset ? "DELETE" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appId: target.appId,
      service: target.service,
      ...(reset ? {} : { mode }),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Couldn't save that choice");
  }
}

/** Toast copy for a saved choice. */
export function trackMessage(label: string, mode: TrackMode, major: number | null): string {
  return mode === "major"
    ? `${label} stays on ${major ?? "its current major"}. Patch and minor updates keep coming.`
    : `${label} follows the latest major.`;
}
