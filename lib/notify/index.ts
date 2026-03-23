"use client";

/**
 * Client-side notification adapter.
 *
 * Usage:
 *   import { notify } from "@/lib/notify";
 *   notify.toast.success("Changes saved");
 *   notify.toast.error("Failed", { description: "Check connection" });
 *   notify.toast.promise(saveFn(), { loading: "Saving...", success: "Done", error: "Failed" });
 *
 * For server-side notifications (email, events), use:
 *   import { notify } from "@/lib/notify/server";
 */

import { toast } from "./toast";

export const notify = {
  toast,
} as const;
