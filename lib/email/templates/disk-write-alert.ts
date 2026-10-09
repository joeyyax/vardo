import type { DiskWriteAlertEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

export function diskWriteAlertMail(event: DiskWriteAlertEvent, ctx: MailContext): NotificationMailBody {
  const name = event.appName || event.containerName;
  const period = event.window || "1h";
  const stack = [event.projectName, event.composeService].filter(Boolean).join(" / ");

  const facts: MailFact[] = [
    { label: "Written", value: `${formatBytesIec(event.writtenBytes)} in ${period}` },
    { label: "Threshold", value: formatBytesIec(event.thresholdBytes) },
  ];
  if (stack) facts.push({ label: "Stack", value: stack });
  if (event.containerName && event.containerName !== name) facts.push({ label: "Container", value: event.containerName, mono: true });

  const why = event.dataEngine
    ? "Sustained heavy writes from a database usually mean a bulk load, a missing index forcing temp tables or runaway logging."
    : "Volumes hold app state, not bulk storage. Heavy writes usually mean debug logging to disk, temp files piling up or data that belongs in S3/R2.";

  return {
    tone: "warn",
    status: "High disk writes",
    heading: `${name} is writing a lot to disk`,
    preheader: `${formatBytesIec(event.writtenBytes)} in ${period}, threshold ${formatBytesIec(event.thresholdBytes)}`,
    paragraphs: [why, "If it's expected, raise the threshold in the app's settings."],
    facts,
    action: event.appId ? { label: "Check app logs", href: appPage(ctx, event.appId, "logs") } : undefined,
    links: event.appId ? [{ label: "Metrics", href: appPage(ctx, event.appId, "metrics") }] : undefined,
    footer: footerFor(ctx),
  };
}
