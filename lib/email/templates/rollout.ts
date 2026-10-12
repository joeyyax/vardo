import type { BusEvent } from "@/lib/bus/events";
import { consolePage, footerFor, type MailContext } from "./context";
import type { NotificationMailBody } from "./components";

type RolloutEvent = Extract<BusEvent, { type: "system.rollout-started" | "system.rollout-busy" | "system.rollout-paused" | "system.rollout-finished" }>;

function actionUrl(ctx: MailContext, event: RolloutEvent, action?: string, instanceId?: string): string {
  const query = new URLSearchParams({ rollout: event.rolloutId });
  if (action) query.set("action", action);
  if (instanceId) query.set("instance", instanceId);
  return consolePage(ctx, `/rollout-action?${query.toString()}`);
}

export function rolloutMail(event: RolloutEvent, ctx: MailContext): NotificationMailBody {
  const busy = event.members.find((member) => member.instanceId === event.busyInstanceId);
  const sections = [{
    title: "Instance plan",
    facts: event.members.map((member) => ({
      label: member.name,
      value: `${member.priority} · ${member.state}${member.reason ? ` · ${member.reason}` : ""}`,
    })),
  }];
  const base = { facts: [{ label: "Target", value: event.targetLabel, mono: true }], sections, footer: footerFor(ctx) };
  if (event.type === "system.rollout-started") return {
    ...base, tone: "info", status: "Rolling out", heading: "An automatic update to your instances is rolling out.",
    paragraphs: ["Ready instances update in priority order. Busy instances wait for a safe moment."],
    action: { label: "Roll out everywhere now", href: actionUrl(ctx, event, "immediate") },
    links: [{ label: "View rollout", href: actionUrl(ctx, event) }],
  };
  if (event.type === "system.rollout-busy") return {
    ...base, tone: "warn", status: "Waiting", heading: `${busy?.name ?? "An instance"} is still busy`,
    paragraphs: ["Vardo will keep waiting unless you choose an action."],
    action: busy ? { label: `Skip ${busy.name} for this rollout`, href: actionUrl(ctx, event, "skip", busy.instanceId) } : undefined,
    links: [
      { label: "Roll out everywhere now", href: actionUrl(ctx, event, "immediate") },
      { label: "Keep waiting", href: actionUrl(ctx, event) },
    ],
  };
  if (event.type === "system.rollout-paused") return {
    ...base, tone: "fail", status: "Paused", heading: "Vardo paused the instance rollout",
    paragraphs: ["An instance is unreachable or an update failed. Review the issue before retrying."],
    action: { label: "Review rollout", href: actionUrl(ctx, event) },
  };
  return {
    ...base, tone: "success", status: "Finished", heading: "Vardo finished the instance rollout",
    paragraphs: [event.members.some((member) => member.state === "skipped")
      ? "Skipped instances remain on an older version and will join the next rollout."
      : "All participating instances are updated."],
    action: { label: "View summary", href: actionUrl(ctx, event) },
  };
}
