/**
 * Client-side messaging — toast notifications.
 *
 * Usage:
 *   import { toast } from "@/lib/messenger";
 *   toast.success("Saved");
 *   toast.error("Failed", { description: "Check connection" });
 *
 * For server-side messaging (email, event dispatch, bus emit):
 *   import { email, event, emit } from "@/lib/messenger/server";
 */

export { toast } from "./toast";
