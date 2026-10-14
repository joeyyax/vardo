import type { BusEvent, MissingContainer, SystemStartedEvent, UpdateChanges, VardoRestartScope } from "@/lib/bus/events";
import { formatClock, UTC, zoneAbbreviation } from "@/lib/time-zone";
import { formatDuration, formatDurationRough, plural, versionShort } from "../format";
import { missingLabel } from "../subjects";
import { nameLink, type MailBlock, type MailFact, type MailInline, type MailLink, type NotificationMailBody, type StatTile } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

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
      | "system.restarting"
      | "system.restarted"
      | "system.restart-failed"
      | "system.containers-missing";
  }
>;

function seconds(s: number | undefined): string | undefined {
  return s === undefined ? undefined : formatDuration(s * 1000);
}

function rough(s: number): string {
  return formatDurationRough(s * 1000);
}

function fact(label: string, value: string | undefined, mono = false): MailFact[] {
  return value ? [{ label, value, mono }] : [];
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "4f1a9b2", linked to the change history when there is one. */
export function versionLink(version: string, changes: UpdateChanges): MailInline {
  return nameLink(versionShort(version), changes.changesUrl);
}

/** Commits in the update: the listed ones plus any past the list. */
export function commitCount(changes: UpdateChanges): number | undefined {
  return changes.commits?.length ? changes.commits.length + (changes.moreCommits ?? 0) : undefined;
}

function restartPhrase(source: VardoRestartScope["source"]): string {
  if (source === "watchdog") return "the watchdog started";
  if (source === "maintenance") return "you started from Maintenance";
  return "an admin started";
}

const RESTARTED_BY: Record<VardoRestartScope["source"], string> = { watchdog: "The watchdog", maintenance: "Maintenance", console: "An admin" };

function except(n: number): string {
  return n === 1 ? "except this one" : n === 2 ? "except these two" : `except these ${n}`;
}

function missingTable(containers: MissingContainer[], ctx: MailContext): MailBlock {
  return {
    kind: "stats",
    columns: ["App", "Container", "State"],
    rows: containers.map((c) => ({
      name: c.app ?? c.service ?? c.name,
      href: c.appId ? appPage(ctx, c.appId) : undefined,
      cells: [c.app ? (c.service ?? c.name) : "—", { value: c.state, hot: true }],
    })),
  };
}

function missingAction(containers: MissingContainer[], ctx: MailContext): MailLink {
  const [first] = containers;
  const oneApp = first?.app && first.appId && containers.every((c) => c.appId === first.appId);
  return oneApp ? { label: `Open ${first.app}`, href: appPage(ctx, first.appId!) } : { label: "Open projects", href: consolePage(ctx, "/projects") };
}

function versionFooter(ctx: MailContext, version: string) {
  return { ...footerFor(ctx), note: `Version ${version}` };
}

/** The one email for a Vardo restart that finished, from a boot or a restart record. */
function backUpMail(event: SystemStartedEvent, ctx: MailContext): NotificationMailBody {
  const containers = event.containers ?? [];
  const lead: string[] = [];
  if (event.unclean) lead.push("It stopped without shutting down cleanly, like a power loss or a crash. Deploys and backups that were running were cut off.");
  if (event.hostRebooted) {
    lead.push(`The host rebooted. Apps with a restart policy came back on their own${containers.length ? `, ${except(containers.length)}` : ""}.`);
  } else {
    lead.push("Deployed apps weren't affected.");
  }
  const blocks: MailBlock[] = [{ kind: "text", text: lead.join(" ") }];
  if (containers.length) blocks.push(missingTable(containers, ctx));
  if (event.reason && !event.hostRebooted && !event.unclean) blocks.push({ kind: "facts", facts: [{ label: "Reason", value: event.reason }] });
  return {
    tone: containers.length ? "warn" : "success",
    status: "Back up",
    heading: event.downSeconds !== undefined ? `Vardo is back up after ${rough(event.downSeconds)}` : "Vardo is back up",
    preheader: lead.join(" "),
    blocks,
    action: containers.length ? missingAction(containers, ctx) : undefined,
    footer: versionFooter(ctx, event.version),
  };
}

export function lifecycleMail(event: LifecycleEvent, ctx: MailContext): NotificationMailBody {
  const host = ctx.instanceName;
  const footer = footerFor(ctx);
  const tz = ctx.timeZone ?? UTC;

  switch (event.type) {
    case "system.shutdown":
      return {
        tone: "info",
        status: "Stopping",
        mark: "↓",
        heading: `Vardo is stopping on ${host}`,
        paragraphs: ["Deployed apps keep running."],
        facts: [
          { label: "Reason", value: event.reason },
          { label: "Up for", value: formatDuration(event.uptimeSeconds * 1000) },
        ],
        footer: versionFooter(ctx, event.version),
      };
    case "system.started":
      return backUpMail(event, ctx);
    case "system.recovered-unclean": {
      const containers = event.containers ?? [];
      const went = event.lastHeartbeatAt ? new Date(event.lastHeartbeatAt) : undefined;
      const at = went && !Number.isNaN(went.getTime()) ? ` at ${formatClock(went, tz)} ${zoneAbbreviation(went, tz)}` : "";
      const back = event.downSeconds !== undefined ? `, and was back about ${rough(event.downSeconds)} later` : "";
      const lead = `It went down${at} without shutting down cleanly, like a power loss or a crash${back}.${event.hostRebooted ? " The host rebooted." : ""}`;
      const blocks: MailBlock[] = [
        { kind: "text", text: lead },
        {
          kind: "callout",
          tone: "warn",
          title: "Anything running was cut off",
          body: "Deploys and backups that were running stopped with it. Run them again if they didn't finish.",
          action: { label: "Open activity", href: consolePage(ctx, "/activity") },
        },
      ];
      if (containers.length) blocks.push({ kind: "section", title: `${missingLabel(containers)} didn't come back` }, missingTable(containers, ctx));
      return {
        tone: "warn",
        status: "Stopped unexpectedly",
        heading: "Vardo stopped unexpectedly",
        preheader: lead,
        blocks,
        action: containers.length ? missingAction(containers, ctx) : undefined,
        footer: versionFooter(ctx, event.version),
      };
    }
    case "system.update-started":
      return {
        tone: "info",
        status: "Updating",
        mark: "↑",
        heading: `Vardo is updating on ${host}`,
        paragraphs: ["Deployed apps keep running."],
        facts: [
          { label: "Version", value: event.toVersion ? `${versionShort(event.fromVersion)} → ${versionShort(event.toVersion)}` : versionShort(event.fromVersion), mono: true },
          ...fact("Branch", event.branch, true),
        ],
        footer,
      };
    case "system.updated": {
      const commits = commitCount(event);
      const lead: MailInline[] = [`${host} is on `, versionLink(event.toVersion, event), commits ? `, ${plural(commits, "commit")} newer.` : ".", " Your apps kept running throughout."];
      const tiles: StatTile[] = [
        ...(event.durationSeconds !== undefined ? [{ label: "Took", value: formatDuration(event.durationSeconds * 1000) }] : []),
        ...(event.downSeconds ? [{ label: "Console down", value: formatDuration(event.downSeconds * 1000) }] : []),
      ];
      return {
        tone: "success",
        status: "Updated",
        heading: "Vardo updated",
        preheader: `${host} is on ${versionShort(event.toVersion)}.`,
        blocks: [{ kind: "text", text: lead }, ...(tiles.length ? [{ kind: "tiles" as const, tiles }] : [])],
        action: event.changesUrl ? { label: "What changed", href: event.changesUrl } : { label: "Open Vardo", href: consolePage(ctx, "/admin") },
        footer,
      };
    }
    case "system.update-failed": {
      const running = versionShort(event.fromVersion);
      const target = event.toVersion ? ` to ${versionShort(event.toVersion)}` : "";
      const blocks: MailBlock[] = [];
      if (event.rolledBack) blocks.push({ kind: "reassure", strong: "Nothing changed.", text: `Vardo rolled back and is running ${running}. Your apps kept running.` });
      else blocks.push({ kind: "text", text: `Vardo is running ${running}. Your apps kept running.` });
      blocks.push({
        kind: "callout",
        tone: "bad",
        title: event.error ?? `The update failed at ${event.step}`,
        body: `Update${target} stopped at ${event.step.charAt(0).toLowerCase()}${event.step.slice(1)}${event.durationSeconds !== undefined ? ` after ${seconds(event.durationSeconds)}` : ""}.`,
      });
      if (event.logTail?.length) blocks.push({ kind: "section", title: "Last log lines" }, { kind: "log", lines: event.logTail });
      blocks.push({ kind: "section", title: "Retry on the host" }, { kind: "log", lines: ["sudo vardo update"], highlight: [] });
      return {
        tone: "fail",
        status: "Update failed",
        heading: "Vardo's update failed",
        preheader: event.error ?? event.message,
        blocks,
        footer,
      };
    }
    case "system.restarting":
      return {
        tone: "info",
        status: "Restarting",
        mark: "↻",
        heading: `Restarting ${event.label} on ${host}`,
        paragraphs: ["Deployed apps keep running."],
        facts: [...fact("Reason", event.reason)],
        footer,
      };
    case "system.restarted": {
      const took = event.durationSeconds !== undefined ? ` after ${rough(event.durationSeconds)}` : "";
      const why = event.reason ? `: ${event.reason.charAt(0).toLowerCase()}${event.reason.slice(1)}` : "";
      const lead = `${RESTARTED_BY[event.source]} restarted it${why}. Deployed apps weren't affected.`;
      return {
        tone: "success",
        status: "Back up",
        heading: event.target === "services" ? `${capitalize(event.label)} restarted` : `${capitalize(event.label)} is back up${took}`,
        preheader: lead,
        blocks: [{ kind: "text", text: lead }],
        footer,
      };
    }
    case "system.restart-failed": {
      const waited = event.durationSeconds !== undefined ? rough(event.durationSeconds) : undefined;
      const phrase = restartPhrase(event.source);
      const title = event.notBack?.length
        ? `${event.notBack.join(", ")} ${event.notBack.length === 1 ? "isn't" : "aren't"} back`
        : event.error;
      const body = event.notBack?.length
        ? `Still not back ${waited ? `${waited} ` : ""}after the restart ${phrase}.`
        : waited ? `Vardo waited ${waited} after the restart ${phrase}.` : undefined;
      return {
        tone: "fail",
        status: "Didn't come back",
        heading: `${capitalize(event.label)} didn't come back`,
        preheader: event.error,
        blocks: [
          { kind: "reassure", strong: "Your apps are still serving.", text: "Vardo itself can't deploy or back up until this is fixed." },
          { kind: "callout", tone: "bad", title, body, action: { label: "Open maintenance", href: consolePage(ctx, "/admin/settings/maintenance") } },
        ],
        footer,
      };
    }
    case "system.containers-missing":
      return {
        tone: "warn",
        status: "Didn't come back",
        heading: `${missingLabel(event.containers)} didn't come back`,
        preheader: "These were running before the host restarted and aren't now.",
        blocks: [{ kind: "text", text: "These were running before the host restarted and aren't now." }, missingTable(event.containers, ctx)],
        action: missingAction(event.containers, ctx),
        footer,
      };
  }
}

