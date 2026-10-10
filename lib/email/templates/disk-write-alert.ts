import type { DiskWriteAlertEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { stackedName } from "../format";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { hourlyColumns } from "./visuals";

export function diskWriteAlertMail(event: DiskWriteAlertEvent, ctx: MailContext): NotificationMailBody {
  const name = stackedName(event.appName || event.containerName, event.projectName);
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
    paragraphs: [why, "If it's expected, raise the disk write alert threshold in the app's resource settings."],
    visuals: [
      hourlyColumns("Written per hour, last 24 h", ctx.series?.diskWritesHourly, {
        over: event.thresholdBytes,
        caption: `Hours over the ${formatBytesIec(event.thresholdBytes)} threshold are amber`,
      }),
    ].filter((v) => v !== undefined),
    facts,
    action: event.appId ? { label: "Raise the threshold", href: `${appPage(ctx, event.appId, "resources")}#edit-disk-write-threshold` } : undefined,
    links: event.appId
      ? [
          { label: "App logs", href: appPage(ctx, event.appId, "logs") },
          { label: "Metrics", href: appPage(ctx, event.appId, "metrics") },
        ]
      : undefined,
    footer: footerFor(ctx),
  };
}
