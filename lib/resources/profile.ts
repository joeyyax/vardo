// Resource profiles: fixed, burstable or auto, set per app or inherited from the org.

import type { ResourceProfile } from "@/lib/db/schema/enums";

export type { ResourceProfile };

/** The app's own profile, else the org's, else fixed. */
export function effectiveProfile(app: ResourceProfile | null | undefined, org: ResourceProfile | null | undefined): ResourceProfile {
  return app ?? org ?? "fixed";
}

/** Burstable memory baseline in MB: the app's, else half the ceiling. Always under the ceiling. */
export function burstableReservationMb(limitMb: number, reservationMb: number | null | undefined): number {
  const wanted = reservationMb && reservationMb > 0 ? reservationMb : Math.floor(limitMb / 2);
  return Math.max(1, Math.min(wanted, limitMb));
}

/** `mem_reservation` for a deploy, or null when the profile isn't burstable. */
export function memoryReservationFor(input: {
  profile: ResourceProfile;
  reservationMb: number | null | undefined;
  /** The limit in force: the app's, else the tier default. */
  limitMb: number;
}): number | null {
  if (input.profile !== "burstable" || input.limitMb <= 0) return null;
  return burstableReservationMb(input.limitMb, input.reservationMb);
}

export type EffectiveMemory = {
  profile: ResourceProfile;
  /** Hard limit in MB. Null is none. */
  limitMb: number | null;
  /** Burstable baseline in MB. */
  reservationMb: number | null;
  /** "Auto-raised on Oct 10 after an OOM kill". */
  why: string;
};

/** The memory limit in force and why, for the Resources tab. */
export function describeMemory(input: {
  appProfile: ResourceProfile | null;
  orgProfile: ResourceProfile | null;
  appLimitMb: number | null;
  reservationMb: number | null;
  tierDefaultMb: number;
  tier: string;
  /** Bytes the running container reports. Null when nothing runs. */
  containerLimitBytes: number | null;
  autotune: { appliedMb: number | null; lastChangedAt: Date | null; lastRaisedAt: Date | null; lastReason: string | null; haltedAt: Date | null } | null;
  formatDate: (d: Date) => string;
}): EffectiveMemory {
  const profile = effectiveProfile(input.appProfile, input.orgProfile);
  const inherited = input.appProfile === null ? " (organization default)" : "";
  const running = input.containerLimitBytes ? Math.round(input.containerLimitBytes / 1024 / 1024) : null;
  const limitMb = input.appLimitMb && input.appLimitMb > 0 ? input.appLimitMb : (running ?? input.tierDefaultMb);
  const reservationMb = memoryReservationFor({ profile, reservationMb: input.reservationMb, limitMb });

  const auto = input.autotune;
  const ours = auto && auto.appliedMb !== null && auto.appliedMb === input.appLimitMb;
  let why: string;
  if (profile === "auto" && ours && auto.lastChangedAt) {
    const raised = auto.lastRaisedAt?.getTime() === auto.lastChangedAt.getTime();
    why = `Auto-${raised ? "raised" : "lowered"} on ${input.formatDate(auto.lastChangedAt)}${auto.lastReason ? ` ${auto.lastReason}` : ""}`;
    if (auto.haltedAt) why += ". Auto-adjust has stopped: it kept outgrowing the limit";
  } else if (input.appLimitMb && input.appLimitMb > 0) {
    why = "Set in Vardo";
  } else if (running !== null && running !== input.tierDefaultMb) {
    why = "Set in compose";
  } else {
    why = `The ${input.tier} tier default`;
  }
  if (profile === "auto" && !ours) why += "; auto hasn't changed it yet";
  if (profile === "burstable" && reservationMb !== null) why += `; ${reservationMb} MB guaranteed, bursting to ${limitMb} MB`;
  return { profile, limitMb, reservationMb, why: `${why}${inherited ? `. Profile: ${profile}${inherited}` : ""}.` };
}
