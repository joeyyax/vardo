// Which major a service follows. "latest" offers new majors; "major" stays on the running one.

import { ownsDataDirectory } from "./stateful-image";

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
  /** False when the mode is the default for this image. */
  explicit: boolean;
}

/** Stateful images stay on their major; everything else follows latest. */
export function defaultTrackMode(image: string): TrackMode {
  return ownsDataDirectory(image) ? "major" : "latest";
}

export function trackKey(appId: string, service: string | null): string {
  return `${appId}:${service ?? ""}`;
}

export function indexTracks(policies: TrackPolicy[]): Map<string, TrackMode> {
  return new Map(policies.map((p) => [trackKey(p.appId, p.composeService), p.mode]));
}

export function resolveTrack(
  index: Map<string, TrackMode>,
  appId: string | undefined,
  service: string | null,
  image: string,
): ResolvedTrack {
  const mode = appId ? index.get(trackKey(appId, service)) : undefined;
  return mode ? { mode, explicit: true } : { mode: defaultTrackMode(image), explicit: false };
}
