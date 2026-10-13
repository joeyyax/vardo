import type { DeployIncompleteEvent } from "@/lib/bus/events";
import { appLabel, oldVersionStillRunning } from "../subjects";
import { nameLink, type MailBlock, type MailInline, type NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { domainsOf, projectFact } from "./deploy-facts";

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

/** The daemon's own words: "tried to kill container, but did not receive an exit event". */
export function daemonReason(output: string | undefined): string | undefined {
  const line = output?.split("\n")[0].replace(/^Error response from daemon:\s*/i, "").trim();
  if (!line) return undefined;
  return line.split(/:\s+/).at(-1)?.replace(/\.$/, "") || undefined;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function deployIncompleteMail(event: DeployIncompleteEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const { text, command, output } = splitCommand(event.reason);
  const oldRunning = oldVersionStillRunning(event.reason);
  const primary = domainsOf(event)[0];

  const lead: MailInline[] = ["The new version passed its health check and is serving"];
  lead.push(...(primary ? [" ", nameLink(primary, `https://${primary}`), "."] : ["."]));
  if (oldRunning) lead.push(" Docker didn't stop the old one, so it's still using memory, disk and a port.");

  const blocks: MailBlock[] = [{ kind: "text", text: lead }];
  if (oldRunning) {
    const said = daemonReason(output);
    blocks.push({ kind: "callout", tone: "warn", title: "Stop the old version on the host", body: said ? `Docker reported: ${said}.` : undefined });
  } else {
    const title = sentence(command ? text.split(" — ")[0] : text);
    blocks.push({ kind: "callout", tone: "warn", title, body: command ? "Run the command below on the host to finish it." : undefined });
    if (output) blocks.push({ kind: "log", lines: output.split("\n") });
  }
  if (command) blocks.push({ kind: "log", lines: [command], highlight: [] });
  const facts = projectFact(event, ctx);
  if (facts.length) blocks.push({ kind: "facts", facts });

  return {
    tone: "warn",
    status: "Needs a look",
    heading: oldRunning ? `${name} is live, but the old version didn't stop` : `${name} is live, but cleanup didn't finish`,
    preheader: oldRunning ? "The new version is serving. The old one is still running." : `The new version is serving. ${sentence(text.split(" — ")[0])}.`,
    blocks,
    action: { label: `Open ${name}`, href: appPage(ctx, event.appId) },
    links: [{ label: "Deployment log", href: appPage(ctx, event.appId, "deployments") }],
    footer: footerFor(ctx),
  };
}
