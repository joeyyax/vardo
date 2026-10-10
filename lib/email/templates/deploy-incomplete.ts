import type { DeployIncompleteEvent } from "@/lib/bus/events";
import { appLabel } from "../subjects";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { changeFacts, phaseVisual, placeFacts } from "./deploy-facts";

/** A shell command quoted in the reason, e.g. `docker compose ... up -d`. */
export function splitCommand(reason: string): { text: string; command?: string; output?: string } {
  const failed = reason.match(/Command failed: ([^\n]+)\n?([\s\S]*)$/);
  if (failed) {
    const text = reason.slice(0, failed.index).replace(/[\s—:-]+$/, "").trim() || "A host command failed";
    return { text, command: failed[1].trim(), output: failed[2].trim() || undefined };
  }
  const backticked = reason.match(/`([^`]{8,})`/);
  if (backticked) {
    const text = reason.replace(backticked[0], "the command below").replace(/\s+/g, " ").trim();
    return { text, command: backticked[1].trim() };
  }
  const bare = reason.match(/((?:\bcd\s+\S+\s+&&\s+)?(?:\bsudo\s+)?\bdocker(?:\s+compose)?\s+[^\n]+?)(?:[.;]\s|[.;]?$)/);
  if (bare) {
    const text = reason.replace(bare[1], "the command below").replace(/\s+/g, " ").trim();
    return { text, command: bare[1].trim() };
  }
  return { text: reason };
}

export function deployIncompleteMail(event: DeployIncompleteEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const { text, command, output } = splitCommand(event.reason);

  const facts: MailFact[] = [{ label: "Unfinished", value: text }, ...placeFacts(event), ...changeFacts(event)];
  if (event.slot) facts.push({ label: "Serving from", value: event.slot });

  return {
    tone: "warn",
    status: "Needs a look",
    heading: `${name} is live, but post-deploy work didn't finish`,
    preheader: text,
    paragraphs: [
      "The new release passed its health check and is serving traffic.",
      "Work that runs after the cutover stopped partway. Until it's finished the old slot may keep running, use disk and hold a port.",
    ],
    visuals: [phaseVisual(event.stageTimings)].filter((v) => v !== undefined),
    facts,
    log: output ? { title: "Error", lines: output.split("\n") } : undefined,
    command: command ? { title: "Run on the host to finish it", text: command } : undefined,
    action: { label: "Open deployment log", href: appPage(ctx, event.appId, "deployments") },
    links: [{ label: "App", href: appPage(ctx, event.appId) }],
    footer: footerFor(ctx),
  };
}
