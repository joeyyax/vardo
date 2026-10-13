import type { CustomBlock } from "../blocks";

/** What a scan looks for. A template is recognized when any signal matches. */
export type TemplateSignal =
  | { image: RegExp }
  | { path: string; body?: RegExp }
  | { cookie: string }
  | { header: string; value?: RegExp };

/** A bundle of let-through and turn-away entries for a stack. */
export type ProbeTemplate = {
  id: string;
  name: string;
  description: string;
  /** Raise it when the entries change; an ignored recommendation reopens once. */
  version: number;
  detect: readonly TemplateSignal[];
  /** Path prefixes the managed rules skip. */
  letThrough?: readonly string[];
  /** Entries the app answers with 403. */
  turnAway: readonly Pick<CustomBlock, "kind" | "value" | "note">[];
};
