// Resource profile copy shared by the app and org settings.

export type ResourceProfile = "fixed" | "burstable" | "auto";

export const MEMORY_PROFILE_HINTS: Record<ResourceProfile, string> = {
  fixed: "A hard limit that only changes when you change it. Alerts suggest a new one.",
  burstable: "A guaranteed baseline plus a hard ceiling it can burst to. The baseline defaults to half the limit.",
  auto: "Starts at the tier default and settles: raised after a memory kill or 10 minutes over 90%, at most every 6 hours, and lowered after 14 quiet days.",
};
