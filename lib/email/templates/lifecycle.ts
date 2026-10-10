import type { BusEvent } from "@/lib/bus/events";
import { formatDuration } from "../format";
import type { MailFact, NotificationMailBody } from "./components";
import { consolePage, footerFor, type MailContext } from "./context";

export type LifecycleEvent = Extract<
  BusEvent,
  {
    type:
      | "system.shutdown"
      | "system.started"
      | "system.recovered-unclean"
      | "system.update-started"
      | "system.updated"
      | "system.update-failed"
      | "system.update-skipped"
      | "system.containers-missing";
  }
>;

function seconds(s: number | undefined): string | undefined {
  return s === undefined ? undefined : formatDuration(s * 1000);
}

function fact(label: string, value: string | undefined, mono = false): MailFact[] {
  return value ? [{ label, value, mono }] : [];
}

function slots(from?: string, to?: string): string | undefined {
  return from && to ? `${from} → ${to}` : to ?? from;
}

export function lifecycleMail(event: LifecycleEvent, ctx: MailContext): NotificationMailBody {
  const host = ctx.instanceName;
  const footer = footerFor(ctx);
  const admin = { label: "Open admin", href: consolePage(ctx, "/admin") };

  switch (event.type) {
    case "system.shutdown":
      return {
        tone: "info",
        status: "Shutting down",
        mark: "↓",
        heading: `Vardo is shutting down on ${host}`,
        paragraphs: ["Deployed apps keep running. You'll get another email when the console is back."],
        facts: [
          { label: "Reason", value: event.reason },
          { label: "Version", value: event.version, mono: true },
          { label: "Up for", value: formatDuration(event.uptimeSeconds * 1000) },
        ],
        footer,
      };
    case "system.started": {
      const down = seconds(event.downSeconds);
      return {
        tone: "success",
        status: "Back up",
        heading: down ? `Vardo is back on ${host} after ${down}` : `Vardo started on ${host}`,
        paragraphs: [event.hostRebooted ? "The host rebooted. Apps with a restart policy come back on their own; you'll hear about any that don't." : "The console restarted. Deployed apps weren't affected."],
        facts: [
          ...fact("Down for", down),
          { label: "Host rebooted", value: event.hostRebooted ? "Yes" : "No" },
          ...fact("Reason", event.reason),
          { label: "Version", value: event.version, mono: true },
        ],
        action: admin,
        footer,
      };
    }
    case "system.recovered-unclean": {
      const down = seconds(event.downSeconds);
      return {
        tone: "warn",
        status: "Unclean stop",
        heading: `Vardo recovered on ${host} after an unclean stop`,
        paragraphs: [
          "The console stopped without shutting down cleanly, as with a power loss, a forced power-off or a crash.",
          "Deploys and backups that were running were cut off. Check them before relying on them.",
        ],
        facts: [
          ...fact("Down for", down ? `about ${down}` : undefined),
          ...fact("Last heartbeat", event.lastHeartbeatAt),
          { label: "Host rebooted", value: event.hostRebooted ? "Yes" : "No" },
          { label: "Version", value: event.version, mono: true },
        ],
        action: admin,
        links: [{ label: "Activity", href: consolePage(ctx, "/activity") }],
        footer,
      };
    }
    case "system.update-started":
      return {
        tone: "info",
        status: "Updating",
        mark: "↑",
        heading: `Vardo is updating on ${host}`,
        paragraphs: ["The console is briefly unavailable during the swap. Deployed apps keep running."],
        facts: [
          { label: "From", value: event.fromVersion, mono: true },
          ...fact("Branch", event.branch, true),
          ...fact("Slot", slots(event.fromSlot, event.toSlot)),
        ],
        footer,
      };
    case "system.updated":
      return {
        tone: "success",
        status: "Updated",
        heading: `Vardo updated on ${host}`,
        preheader: `${event.fromVersion} → ${event.toVersion}`,
        facts: [
          { label: "Version", value: `${event.fromVersion} → ${event.toVersion}`, mono: true },
          ...fact("Slot", slots(event.fromSlot, event.toSlot)),
          ...fact("Took", seconds(event.durationSeconds)),
          ...fact("Console down", seconds(event.downSeconds)),
        ],
        action: admin,
        footer,
      };
    case "system.update-failed":
      return {
        tone: "fail",
        status: "Update failed",
        heading: `Vardo update failed on ${host} at ${event.step}`,
        preheader: event.error ?? event.message,
        paragraphs: [
          event.rolledBack ? `The console rolled back and is running ${event.fromVersion}.` : `The console is still running ${event.fromVersion}.`,
          "Fix the cause, then run the update again.",
        ],
        facts: [
          { label: "Failed at", value: event.step },
          ...fact("Error", event.error),
          { label: "Version", value: event.toVersion ? `${event.fromVersion} → ${event.toVersion}` : event.fromVersion, mono: true },
          ...fact("Slot", slots(event.fromSlot, event.toSlot)),
          ...fact("Ran for", seconds(event.durationSeconds)),
        ],
        log: event.logTail?.length ? { title: "Last log lines", lines: event.logTail } : undefined,
        command: { title: "Retry on the host", text: "sudo vardo update" },
        footer,
      };
    case "system.update-skipped":
      return {
        tone: "warn",
        status: "Update skipped",
        heading: `Vardo didn't update on ${host}`,
        preheader: event.reasons[0] ?? event.message,
        paragraphs: [`The automatic update to ${event.target} didn't pass its checks. It tries again in the next maintenance window.`],
        facts: [
          { label: "Running", value: event.fromVersion, mono: true },
          { label: "Target", value: event.target, mono: true },
        ],
        sections: [{ title: "Checks that failed", facts: event.reasons.map((r, i) => ({ label: String(i + 1), value: r })) }],
        action: { label: "Open updates", href: consolePage(ctx, "/admin/settings/maintenance#updates") },
        footer,
      };
    case "system.containers-missing":
      return {
        tone: "warn",
        status: "Containers missing",
        heading: `${event.containers.length === 1 ? "1 container" : `${event.containers.length} containers`} didn't come back on ${host}`,
        paragraphs: ["These were running before the restart and aren't now. Redeploy or start them from their app."],
        sections: [
          {
            title: "Not running",
            facts: event.containers.map((c) => ({ label: c.app ?? c.name, value: c.app ? `${c.name} (${c.state})` : c.state })),
          },
        ],
        action: { label: "Open projects", href: consolePage(ctx, "/projects") },
        footer,
      };
  }
}
