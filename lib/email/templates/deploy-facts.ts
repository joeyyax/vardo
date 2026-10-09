import type { DeployDetails } from "@/lib/bus/events";
import { commitUrl, shortSha, triggerLabel } from "../format";
import type { MailFact } from "./components";

type DeployFactInput = DeployDetails & {
  domain?: string;
  gitSha?: string;
  gitMessage?: string;
  triggeredBy?: string;
};

/** Where the app lives: project, environment and domains. */
export function placeFacts(event: DeployFactInput): MailFact[] {
  const facts: MailFact[] = [];
  if (event.project) facts.push({ label: "Project", value: event.project });
  if (event.environment) facts.push({ label: "Environment", value: event.environment });
  const domains = event.domains?.length ? event.domains : event.domain ? [event.domain] : [];
  for (const [index, domain] of domains.slice(0, 5).entries()) {
    facts.push({ label: index === 0 ? (domains.length > 1 ? "Domains" : "Domain") : "", value: domain, href: `https://${domain}` });
  }
  if (domains.length > 5) facts.push({ label: "", value: `and ${domains.length - 5} more` });
  return facts;
}

/** What shipped: commit, author, branch and trigger. */
export function changeFacts(event: DeployFactInput): MailFact[] {
  const facts: MailFact[] = [];
  if (event.gitSha) {
    const message = event.gitMessage ? ` ${event.gitMessage}` : "";
    facts.push({ label: "Commit", value: `${shortSha(event.gitSha)}${message}`, href: commitUrl(event.repoUrl, event.gitSha) });
  }
  if (event.gitAuthor) facts.push({ label: "Author", value: event.gitAuthor });
  if (event.gitBranch) facts.push({ label: "Branch", value: event.gitBranch, mono: true });
  const trigger = triggerLabel(event.trigger, event.triggeredBy);
  if (trigger) facts.push({ label: "Trigger", value: trigger });
  return facts;
}
