import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { imageUpdateTracks } from "@/lib/db/schema";
import type { TrackPolicy } from "./track-policy";

/** Every explicit track policy in an org. */
export async function readTrackPolicies(orgId: string): Promise<TrackPolicy[]> {
  return db
    .select({
      appId: imageUpdateTracks.appId,
      composeService: imageUpdateTracks.composeService,
      mode: imageUpdateTracks.mode,
    })
    .from(imageUpdateTracks)
    .where(eq(imageUpdateTracks.organizationId, orgId));
}
