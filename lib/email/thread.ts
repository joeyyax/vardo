// Threading for incident emails: every message about one incident shares a root Message-ID.

import type { IncidentRef } from "@/lib/incidents/types";

/** `root` is the opening email's Message-ID; `reply` marks updates and the resolution. */
export type MailThread = { root: string; reply: boolean };

export type OutboundMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo?: string;
  thread?: MailThread;
};

/** `<inc_…@host>`, the same for every email about the incident. */
export function incidentMessageId(incidentId: string, host: string): string {
  return `<${incidentId}@${host || "vardo.invalid"}>`;
}

export function incidentThread(incident: IncidentRef, host: string): MailThread {
  return { root: incidentMessageId(incident.id, host), reply: incident.transition !== "opened" };
}

/** For providers that set Message-ID themselves: every message references the root. */
export function threadHeaders(thread: MailThread | undefined): Record<string, string> {
  if (!thread) return {};
  return thread.reply ? { "In-Reply-To": thread.root, References: thread.root } : { References: thread.root };
}

/** For SMTP, where the opening email can carry the root as its own Message-ID. */
export function smtpThread(thread: MailThread | undefined): { messageId?: string; inReplyTo?: string; references?: string } {
  if (!thread) return {};
  return thread.reply ? { inReplyTo: thread.root, references: thread.root } : { messageId: thread.root };
}
