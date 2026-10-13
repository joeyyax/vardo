import type { DeployRollbackEvent } from "@/lib/bus/events";
import { formatDayTime, UTC } from "@/lib/time-zone";
import { commitUrl, plural, shortSha } from "../format";
import { appLabel } from "../subjects";
import { nameLink, type MailBlock, type MailFact, type MailInline, type NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { commitFact, commitInline, projectFact } from "./deploy-facts";

/** "40 seconds", "3 minutes", "2 hours". */
export function spokenDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return plural(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return plural(minutes, "minute");
  return plural(Math.round(minutes / 60), "hour");
}

function logBlocks(event: DeployRollbackEvent): MailBlock[] {
  return event.logTail?.length ? [{ kind: "section", title: "Last log lines" }, { kind: "log", lines: event.logTail }] : [];
}

export function autoRollbackMail(event: DeployRollbackEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const logs = { label: "App logs", href: appPage(ctx, event.appId, "logs") };
  const deployment = { label: "Open the deployment", href: appPage(ctx, event.appId, "deployments") };
  const commit = commitInline(event);

  if (!event.rollbackSuccess) {
    const facts: MailFact[] = [...projectFact(event, ctx), ...commitFact(event)];
    return {
      tone: "fail",
      status: "Rollback failed",
      heading: `${name} crashed and the rollback failed`,
      preheader: `Nothing may be serving ${name}.`,
      blocks: [
        {
          kind: "callout",
          tone: "bad",
          title: `Nothing may be serving ${name}`,
          body: `The new version stopped after going live. ${event.message}`,
          action: logs,
        },
        ...logBlocks(event),
        ...(facts.length ? [{ kind: "facts" as const, facts }] : []),
      ],
      action: { label: `Open ${name}`, href: appPage(ctx, event.appId) },
      links: [{ label: "Deployment log", href: deployment.href }],
      footer: footerFor(ctx),
    };
  }

  const serving: MailInline[] = event.servingSha
    ? ["The previous version, ", nameLink(shortSha(event.servingSha), commitUrl(event.repoUrl, event.servingSha)), ", is serving again."]
    : ["The previous version is serving again."];
  const stopped = event.liveMs !== undefined ? `${spokenDuration(event.liveMs)} after going live` : "soon after going live";
  const why = " passed its health check, then its containers exited, so Vardo switched traffic back.";

  const facts: MailFact[] = [...projectFact(event, ctx)];
  if (event.rolledBackAt) facts.push({ label: "Rolled back", value: formatDayTime(new Date(event.rolledBackAt), ctx.timeZone ?? UTC) });

  return {
    tone: "warn",
    status: "Rolled back",
    heading: `${name} rolled back`,
    preheader: `The site is up. The new version stopped ${stopped}.`,
    blocks: [
      { kind: "reassure", strong: "The site is up.", text: serving },
      {
        kind: "callout",
        tone: "bad",
        title: `The new version stopped ${stopped}`,
        body: commit.length ? [...commit, why] : `It${why}`,
        action: logs,
      },
      ...logBlocks(event),
      ...(facts.length ? [{ kind: "facts" as const, facts }] : []),
    ],
    action: deployment,
    footer: footerFor(ctx),
  };
}
