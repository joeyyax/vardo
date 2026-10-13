import type { BusEvent } from "@/lib/bus/events";
import { consolePage, footerFor, type MailContext } from "./context";
import type { MailBlock, NotificationMailBody } from "./components";

type RolloutEvent = Extract<BusEvent, { type: "system.rollout-started" | "system.rollout-busy" | "system.rollout-paused" | "system.rollout-finished" }>;

const priorityOrder = { critical: 0, standard: 1, low: 2 } as const;

const STATES: Record<string, string> = { waiting: "Waiting", busy: "Busy", updating: "Updating", verified: "Updated", failed: "Failed", unreachable: "Unreachable", skipped: "Skipped" };

function memberStatus(member: RolloutEvent["members"][number]): string {
  const state = STATES[member.state] ?? member.state;
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
  const table = (states: string[]): MailBlock => ({
    kind: "stats",
    columns: ["Instance", "State"],
    rows: members.map((member) => ({
      name: member.name,
      why: member.reason ?? undefined,
      cells: [{ value: STATES[member.state] ?? member.state, hot: states.includes(member.state) }],
    })),
  });
  if (event.type === "system.rollout-paused") {
    const stuck = members.filter((member) => member.state === "failed" || member.state === "unreachable");
    return {
      tone: "fail",
      status: "Paused",
      heading: "Vardo's update paused",
      preheader: `${memberNames(stuck.length ? stuck : members)} ${stuck.length === 1 ? "needs" : "need"} a look before the update to ${event.targetLabel} goes on.`,
      blocks: [
        { kind: "reassure", strong: "Your apps kept running.", text: "Instances that didn't update stay on their version." },
        { kind: "text", text: `The update to ${event.targetLabel} stopped. Fix what's below, then retry the rollout.` },
        table(["failed", "unreachable"]),
      ],
      action: { label: "Review rollout", href: actionUrl(ctx, event) },
      footer: footerFor(ctx),
    };
  }
  const skipped = members.filter((member) => member.state === "skipped");
  const updated = members.filter((member) => member.state !== "skipped");
  const on = `${memberNames(updated)} ${updated.length === 1 ? "is" : "are"} on ${event.targetLabel}.`;
  const lead = skipped.length ? `${on} Skipped instances stay on their version and join the next rollout.` : `${on} Your apps kept running throughout.`;
  return {
    tone: skipped.length ? "warn" : "success",
    status: "Updated",
    heading: "Vardo updated",
    preheader: lead,
    blocks: [{ kind: "text", text: lead }, ...(skipped.length ? [table(["skipped"])] : [])],
    action: { label: "View rollout", href: actionUrl(ctx, event) },
    footer: footerFor(ctx),
  };
}
