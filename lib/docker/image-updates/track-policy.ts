// Which major a service follows. "latest" offers new majors; "major" stays on the running one.

import { verdictByName, type StatefulVerdict } from "./stateful-detect";

export type TrackMode = "latest" | "major";

export const TRACK_MODES = ["latest", "major"] as const satisfies readonly TrackMode[];

export interface TrackPolicy {
  appId: string;
  /** Compose service. Null for a single-image app. */
  composeService: string | null;
  mode: TrackMode;
}

export interface ResolvedTrack {
  mode: TrackMode;
  /** False when the mode is the default for this service. */
  explicit: boolean;
  /** What the service would follow with no policy. */
  defaultMode: TrackMode;
  /** Why the default is "major", e.g. "stores data in /var/lib/postgresql/data". */
  reason: string | null;
}

/** Services that own a data directory stay on their major; everything else follows latest. */
export function defaultTrackMode(image: string, verdict?: StatefulVerdict | null): TrackMode {
  return (verdict ?? verdictByName(image)).ownsData ? "major" : "latest";
}

export function trackKey(appId: string, service: string | null): string {
  return `${appId}:${service ?? ""}`;
}

export function indexTracks(policies: TrackPolicy[]): Map<string, TrackMode> {
  return new Map(policies.map((p) => [trackKey(p.appId, p.composeService), p.mode]));
}

/** An explicit policy always wins over the detected default. */
export function resolveTrack(
  index: Map<string, TrackMode>,
  appId: string | undefined,
  service: string | null,
  image: string,
  verdict?: StatefulVerdict | null,
): ResolvedTrack {
  const detected = verdict ?? verdictByName(image);
  const defaultMode: TrackMode = detected.ownsData ? "major" : "latest";
  const reason = defaultMode === "major" ? detected.reason : null;
  const mode = appId ? index.get(trackKey(appId, service)) : undefined;
  return mode
    ? { mode, explicit: true, defaultMode, reason }
    : { mode: defaultMode, explicit: false, defaultMode, reason };
}
