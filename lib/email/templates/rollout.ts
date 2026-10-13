import type { BusEvent } from "@/lib/bus/events";
import { consolePage, footerFor, type MailContext } from "./context";
import type { NotificationMailBody } from "./components";

type RolloutEvent = Extract<BusEvent, { type: "system.rollout-started" | "system.rollout-busy" | "system.rollout-paused" | "system.rollout-finished" }>;

const priorityOrder = { critical: 0, standard: 1, low: 2 } as const;

function memberStatus(member: RolloutEvent["members"][number]): string {
  const states: Record<string, string> = { waiting: "Waiting", busy: "Busy", updating: "Updating", verified: "Updated", failed: "Failed", unreachable: "Unreachable", skipped: "Skipped" };
  const state = states[member.state] ?? member.state;
  const priority = `${member.priority[0].toUpperCase()}${member.priority.slice(1)} priority`;
  return `${state} · ${priority}${member.reason ? ` · ${member.reason}` : ""}`;
}

function memberNames(members: RolloutEvent["members"]): string {
  const names = members.map((member) => member.name);
  return names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function actionUrl(ctx: MailContext, event: RolloutEvent, action?: string, instanceId?: string): string {
  const query = new URLSearchParams({ rollout: event.rolloutId });
  if (action) query.set("action", action);
  if (instanceId) query.set("instance", instanceId);
  return consolePage(ctx, `/rollout-action?${query.toString()}`);
}

export function rolloutMail(event: RolloutEvent, ctx: MailContext): NotificationMailBody {
  const busy = event.members.find((member) => member.instanceId === event.busyInstanceId);
  const members = [...event.members].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.name.localeCompare(b.name));
  const sections = [{ title: event.type === "system.rollout-started" ? "Update order" : "Instance status", facts: members.map((member, index) => ({
    label: event.type === "system.rollout-started" ? `${index + 1}. ${member.name}` : member.name,
    value: memberStatus(member),
  })) }];
  const base = { details: [{ label: "Target version", value: event.targetLabel, mono: true }], footer: footerFor(ctx) };
  if (event.type === "system.rollout-started") return {
    ...base, tone: "info", status: `Updating ${event.members.length} instances`, heading: "Vardo is updating your instances",
    paragraphs: [
      "Vardo chooses ready instances by priority. Up to two can update at once; a busy instance waits until it's ready.",
      "Skipping priority order still waits for busy instances.",
    ],
    sections,
    action: { label: "View rollout", href: actionUrl(ctx, event) },
    links: [{ label: "Skip priority order", href: actionUrl(ctx, event, "immediate") }],
  };
  if (event.type === "system.rollout-busy") return {
    ...base, tone: "warn", status: "Waiting", heading: `${busy?.name ?? "An instance"} is busy`,
    paragraphs: ["Vardo will update it when it's ready."],
    sections,
    action: { label: "View rollout", href: actionUrl(ctx, event) },
    links: [
      ...(busy ? [{ label: `Skip ${busy.name} for this rollout`, href: actionUrl(ctx, event, "skip", busy.instanceId) }] : []),
      { label: "Skip priority order", href: actionUrl(ctx, event, "immediate") },
    ],
  };
  if (event.type === "system.rollout-paused") return {
    ...base, tone: "fail", status: "Paused", heading: "Vardo paused the update",
    paragraphs: ["An instance is unreachable or an update failed. Review the issue before retrying."],
    sections,
    action: { label: "Review rollout", href: actionUrl(ctx, event) },
  };
  const skipped = event.members.filter((member) => member.state === "skipped").length;
  const updated = event.members.length - skipped;
  return {
    ...base, tone: "success", status: "Complete", heading: skipped
      ? `${updated} updated, ${skipped} skipped`
      : event.members.length === 2 ? "Both instances are updated" : `${updated} ${updated === 1 ? "instance is" : "instances are"} updated`,
    paragraphs: skipped
      ? ["Skipped instances remain on an older version and will join the next rollout."]
      : [`${memberNames(event.members)} ${event.members.length === 1 ? "is" : "are"} running version ${event.targetLabel}.`],
    sections: skipped ? sections : undefined,
    action: { label: "View rollout summary", href: actionUrl(ctx, event) },
  };
}
