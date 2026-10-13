import type { ScanAppReport, ScanFindingLine, SecurityScanFindingsEvent } from "@/lib/bus/events";
import { plural, truncate } from "../format";
import { nameLink, type MailBlock, type MailRich, type MailTone, type NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

/** Description length in a finding's callout. */
const DESCRIPTION_MAX = 160;

/** What a clean scan looked at. */
export const SCAN_CHECKS = ["exposed files", "headers", "TLS", "open ports"] as const;

const siteUrl = (domain: string) => `https://${domain}`;

/** "Shop · shop.example.com", the name linked to the app. */
function appLine(app: ScanAppReport, ctx: MailContext): MailRich {
  return [nameLink(app.appName, appPage(ctx, app.appId)), ...(app.domain ? [` · ${app.domain}`] : [])];
}

function findingBlock(f: ScanFindingLine, href: string): MailBlock {
  return {
    kind: "callout",
    tone: f.severity === "critical" ? "bad" : "warn",
    title: f.title,
    body: truncate(f.description, DESCRIPTION_MAX),
    action: { label: "View the finding", href },
  };
}

/** One app's findings: critical and warning callouts, info rolled into a note. */
function appBlocks(app: ScanAppReport, ctx: MailContext): MailBlock[] {
  const href = appPage(ctx, app.appId, "security");
  const sorted = [...app.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const shown = sorted.filter((f) => f.severity !== "info");
  const info = sorted.filter((f) => f.severity === "info");
  return [
    { kind: "section", title: appLine(app, ctx) },
    ...shown.map((f) => findingBlock(f, href)),
    ...(info.length ? [{ kind: "note", text: `Also ${plural(info.length, "informational finding")}: ${info.map((f) => f.title).join(", ")}.` } satisfies MailBlock] : []),
  ];
}

function scanSource(event: SecurityScanFindingsEvent): string {
  const of = event.scanned ? ` of ${plural(event.scanned, "app")}` : "";
  if (event.trigger === "deploy") return "From the scan after the deploy.";
  return `From the scheduled scan${of}.`;
}

export function securityScanMail(event: SecurityScanFindingsEvent, ctx: MailContext): NotificationMailBody {
  const apps: ScanAppReport[] = event.apps?.length
    ? event.apps
    : [{ appId: event.appId, appName: event.appName, domain: event.domain, findings: [] }];
  const manual = event.trigger === "manual";
  const findings = apps.flatMap((a) => a.findings);
  const total = findings.length || event.criticalCount + event.warningCount;
  const critical = findings.some((f) => f.severity === "critical") || event.criticalCount > 0;
  const tone: MailTone = total === 0 ? "success" : critical ? "fail" : "warn";
  const [first] = apps;
  const footer = footerFor(ctx);

  if (total === 0) {
    return {
      tone,
      status: "No issues",
      heading: `${first.appName} passed its security scan`,
      preheader: first.domain ? `Nothing turned up on ${first.domain}.` : "Nothing turned up.",
      blocks: [
        { kind: "text", text: first.domain ? ["Nothing turned up on ", nameLink(first.domain, siteUrl(first.domain)), "."] : "Nothing turned up." },
        { kind: "chips", chips: SCAN_CHECKS.map((text) => ({ text })) },
      ],
      action: { label: `Open ${first.appName} security`, href: appPage(ctx, first.appId, "security") },
      footer,
    };
  }

  const reported = apps.filter((a) => a.findings.length);
  const lead = manual
    ? "Every finding from the scan you started is listed."
    : `${scanSource(event)} Only findings that are new since each app's last scan are listed.`;
  const firstFinding = findings.find((f) => f.severity !== "info") ?? findings[0];
  const firstApp = reported.find((a) => a.findings.includes(firstFinding)) ?? first;

  return {
    tone,
    status: manual ? "Findings" : "New findings",
    heading: manual ? `The security scan found ${plural(total, "issue")} on ${first.appName}` : plural(total, "new security finding"),
    preheader: firstFinding ? `${firstFinding.title} on ${firstApp.appName}` : lead,
    blocks: [{ kind: "text", text: lead }, ...reported.flatMap((a) => appBlocks(a, ctx))],
    ...(reported.length ? {} : { action: { label: "Open security", href: appPage(ctx, first.appId, "security") } }),
    footer,
  };
}
