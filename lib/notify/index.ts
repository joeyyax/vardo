"use client";

/**
 * Unified notification adapter.
 *
 * Usage:
 *   import { notify } from "@/lib/notify";
 *   notify.toast.success("Changes saved");
 *   notify.toast.error("Failed", { description: "Check connection" });
 *   notify.toast.promise(saveFn(), { loading: "Saving...", success: "Done", error: "Failed" });
 *
 * Future channels (email, push, chat) are stubbed -- interfaces defined,
 * implementations throw until wired up.
 */

import { toast } from "./toast";
import { email } from "./email";
import { push } from "./push";
import { chat } from "./chat";

export const notify = {
  toast,
  email,
  push,
  chat,
} as const;

// Re-export types for consumers that need them
export type { EmailOptions } from "./email";
export type { PushOptions } from "./push";
export type { ChatOptions } from "./chat";
