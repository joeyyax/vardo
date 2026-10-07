// Server-side messaging: email and event dispatch.

export { email } from "./email";
export { emit } from "./event";

export type { EmailOptions } from "./email";
export type { BusEvent, BusEventType } from "@/lib/bus/events";
