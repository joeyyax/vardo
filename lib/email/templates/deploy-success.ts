import type { DeploySuccessEvent } from "@/lib/bus/events";
import { formatDuration } from "../format";
import { appLabel } from "../subjects";
import { nameLink, type MailBlock, type MailInline, type NotificationMailBody, type StatTile } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { commitInline, domainsFact, domainsOf, phaseSteps, projectFact, triggerFact } from "./deploy-facts";

const ms = (event: DeploySuccessEvent, ...phases: ("build" | "export" | "pull" | "healthWait")[]) =>
  phases.reduce((sum, p) => sum + (event.stageTimings?.[p]?.ms ?? 0), 0);

function tiles(event: DeploySuccessEvent): StatTile[] {
  const out: StatTile[] = [];
  if (event.durationMs !== undefined) {
    const usual = event.usualDurationMs !== undefined ? `usual ${formatDuration(event.usualDurationMs)}` : undefined;
    out.push({ label: "Took", value: formatDuration(event.durationMs), sub: usual });
  }
  const build = ms(event, "build", "export");
  const pull = ms(event, "pull");
  if (build) out.push({ label: "Build", value: formatDuration(build) });
  else if (pull) out.push({ label: "Pull", value: formatDuration(pull), sub: "prebuilt image" });
  const health = ms(event, "healthWait");
  if (health) out.push({ label: "Health check", value: formatDuration(health), sub: "passed" });
  return out.length > 1 ? out : [];
}

/** "First deploy of acme-web. Its 72-hour recap arrives Oct 12." */
export function firstDeployNote(event: DeploySuccessEvent, ctx: MailContext): string | undefined {
  if (!event.firstDeploy) return undefined;
  const name = appLabel(event);
  const recap = event.recapAt ? new Date(event.recapAt) : undefined;
  if (!recap || Number.isNaN(recap.getTime())) return `First deploy of ${name}.`;
  const day = recap.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: ctx.timeZone ?? "UTC" });
  return `First deploy of ${name}. Its 72-hour recap arrives ${day}.`;
}

export function deploySuccessMail(event: DeploySuccessEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const domains = domainsOf(event);
  const primary = domains[0];
  const duration = event.durationMs !== undefined ? formatDuration(event.durationMs) : event.duration;

  const commit = commitInline(event);
  const lead: MailInline[] = commit.length ? [...commit, event.gitAuthor ? `, by ${event.gitAuthor},` : ""] : [nameLink(name, appPage(ctx, event.appId))];
  lead.push(primary ? " is live on " : " is live.");
  if (primary) lead.push(nameLink(primary, `https://${primary}`), ".");

  const blocks: MailBlock[] = [{ kind: "text", text: lead.filter(Boolean) }];
  const tileRow = tiles(event);
  if (tileRow.length) blocks.push({ kind: "tiles", tiles: tileRow });
  const steps = phaseSteps(event.stageTimings);
  if (steps) blocks.push({ kind: "section", title: "Where the time went" }, { kind: "phases", steps });
  blocks.push({
    kind: "facts",
    facts: [
      ...projectFact(event, ctx),
      ...domainsFact(event),
      ...triggerFact(event),
      ...(event.previousSlot && !event.firstDeploy ? [{ label: "Rollback", value: "The previous version is kept ready" }] : []),
    ],
  });
  const note = firstDeployNote(event, ctx);
  if (note) blocks.push({ kind: "note", text: note });

  return {
    tone: "success",
    status: "Deployed",
    heading: `${name} deployed`,
    preheader: [event.gitMessage, duration && `in ${duration}`].filter(Boolean).join(" · ") || `${name} is live`,
    blocks,
    action: primary ? { label: `Open ${primary}`, href: `https://${primary}` } : { label: `Open ${name}`, href: appPage(ctx, event.appId) },
    links: [{ label: "Deployment log", href: appPage(ctx, event.appId, "deployments") }],
    footer: footerFor(ctx),
  };
}
