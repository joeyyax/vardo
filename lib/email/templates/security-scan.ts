import type { ScanAppReport, SecurityScanFindingsEvent } from "@/lib/bus/events";
import { plural, truncate } from "../format";
import type { MailFact, MailLink, MailTone, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

const SEVERITY_LABEL: Record<ScanAppReport["findings"][number]["severity"], string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

/** Description length in a finding's row. */
const DESCRIPTION_MAX = 140;

function findingFacts(app: ScanAppReport, ctx: MailContext): MailFact[] {
  const href = appPage(ctx, app.appId, "security");
  return [...app.findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((f) => ({
      label: SEVERITY_LABEL[f.severity],
      value: `${f.title}. ${truncate(f.description, DESCRIPTION_MAX)}`,
      href,
    }));
}

function appTitle(app: ScanAppReport): string {
  return app.domain ? `${app.appName} · ${app.domain}` : app.appName;
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

  const heading = manual
    ? total
      ? `The security scan found ${plural(total, "issue")} on ${first.appName}`
      : `${first.appName} passed its security scan`
    : apps.length > 1
      ? `${plural(total, "new security finding")} on ${plural(apps.length, "app")}`
      : `${plural(total, "new security finding")} on ${first.appName}`;

  const paragraphs = manual
    ? [total ? "Every finding from the scan you started is listed." : "Nothing turned up in files, headers, TLS or ports."]
    : [
        "Only findings that are new or changed since each app's last scan are listed.",
        ...(event.scanned ? [`${plural(event.scanned, "app")} scanned. Apps without anything new are left out.`] : []),
      ];

  const links: MailLink[] = apps.slice(1).map((a) => ({ label: `${a.appName} security`, href: appPage(ctx, a.appId, "security") }));

  return {
    tone,
    status: total === 0 ? "No issues" : manual ? "Findings" : "New findings",
    heading,
    preheader: findings[0] ? `${findings[0].title} on ${apps.find((a) => a.findings.includes(findings[0]))?.appName ?? first.appName}` : paragraphs[0],
    paragraphs,
    sections: apps.filter((a) => a.findings.length).map((a) => ({ title: appTitle(a), facts: findingFacts(a, ctx) })),
    action: { label: apps.length > 1 ? `Open ${first.appName} security` : "Open security", href: appPage(ctx, first.appId, "security") },
    links,
    footer: footerFor(ctx),
  };
}
