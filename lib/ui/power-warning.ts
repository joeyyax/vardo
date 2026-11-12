"use client";

import { toast } from "@/lib/messenger";

/** Warns that a backup started by hand runs on UPS power. Silent on mains or when the state can't be read. */
export async function warnIfOnBattery(what = "This backup"): Promise<void> {
  try {
    const res = await fetch("/api/v1/system/power");
    if (!res.ok) return;
    const { onBattery } = (await res.json()) as { onBattery?: boolean };
    if (onBattery) toast.warning(`The host is on battery. ${what} runs on UPS power.`);
  } catch {
    // The backup goes ahead either way.
  }
}
