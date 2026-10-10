// The short message every push-style channel sends: a title with the instance prefix, a one-line summary, a few facts and a console link.

import type { BusEvent } from "@/lib/bus/events";
import { notificationMailBody, type MailContext } from "@/lib/email/notification-email";
import { notificationSubject } from "@/lib/email/subjects";
import { truncate } from "@/lib/email/format";
import { mailContext, orgWantsEvent } from "./mail-context";

export type PushSeverity = "critical" | "warning" | "success" | "info";

export type PushFact = { label: string; value: string };

export type PushMessage = {
  /** "node-a · ✗ Shop failed at build". */
  title: string;
  /** One line. */
  summary: string;
  severity: PushSeverity;
  facts: PushFact[];
  /** A console page, never the app's own domain, except an integration fix on the provider. */
  url?: string;
  urlLabel?: string;
  instanceName: string;
  eventType: BusEvent["type"];
  /** Emoji shortcode for the event's kind. */
  emoji: string;
};

const TITLE_MAX = 120;
const SUMMARY_MAX = 160;
const FACT_VALUE_MAX = 120;
const FACTS_MAX = 6;

const TONE_SEVERITY = { fail: "critical", warn: "warning", success: "success", info: "info" } as const;

const EMOJI_BY_PREFIX: [string, string][] = [
  ["alert.fired", "rotating_light"],
  ["alert.resolved", "white_check_mark"],
  ["deploy.", "rocket"],
  ["backup.", "floppy_disk"],
  ["cron.", "alarm_clock"],
  ["security.", "lock"],
  ["disk.", "floppy_disk"],
  ["volume.", "file_cabinet"],
  ["app.", "package"],
  ["system.", "gear"],
  ["digest.", "bar_chart"],
  ["org.", "bust_in_silhouette"],
];

function emojiFor(type: string): string {
  return EMOJI_BY_PREFIX.find(([prefix]) => type.startsWith(prefix))?.[1] ?? "bell";
}

/** The message for an event, or null when it never notifies. Pure: the context carries the console origin and instance name. */
export function pushMessageFor(event: BusEvent, ctx: MailContext): PushMessage | null {
  const body = notificationMailBody(event, ctx);
  if (!body) return null;

  const candidates = [body.action, ...(body.links ?? [])].filter((l) => l !== undefined);
  // An integration's fix lives on the provider's site.
  const link = event.type === "system.integration-permissions"
    ? body.action
    : candidates.find((l) => l.href.startsWith(`${ctx.baseUrl}/`) || l.href === ctx.baseUrl);
  const summary = truncate(body.preheader ?? body.paragraphs?.[0] ?? event.message ?? "", SUMMARY_MAX);
  const facts = (body.facts ?? body.sections?.[0]?.facts ?? [])
    .filter((f) => f.label.trim() && f.value.trim() && truncate(f.value, SUMMARY_MAX) !== summary)
    .slice(0, FACTS_MAX)
    .map((f) => ({ label: truncate(f.label, 40), value: truncate(f.value, FACT_VALUE_MAX) }));

  return {
    title: truncate(notificationSubject(event, ctx), TITLE_MAX),
    summary,
    severity: TONE_SEVERITY[body.tone],
    facts,
    url: link?.href ?? ctx.baseUrl,
    urlLabel: link?.label ?? "Open Vardo",
    instanceName: ctx.instanceName,
    eventType: event.type,
    emoji: emojiFor(event.type),
  };
}

/** The message for one org's channel, or null when the delivery policy leaves this event to the digest or it never notifies. */
export async function pushMessageForOrg(event: BusEvent, organizationId: string | undefined): Promise<PushMessage | null> {
  if (!(await orgWantsEvent(event, organizationId))) return null;
  return pushMessageFor(event, await mailContext(organizationId));
}
