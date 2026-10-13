import type { DiskWriteAlertEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { possessive, stackedName, windowPhrase } from "../format";
import type { ChartTone, MailBlock, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

/** "Shop Staging's MySQL" for a stack child; the plain name otherwise. */
function ownedName(event: DiskWriteAlertEvent): string {
  const name = event.appName || event.containerName;
  const stack = event.projectName;
  if (!stack || name.toLowerCase().startsWith(stack.toLowerCase())) return name;
  return `${possessive(stack)} ${name}`;
}

export function diskWriteAlertMail(event: DiskWriteAlertEvent, ctx: MailContext): NotificationMailBody {
  const name = stackedName(event.appName || event.containerName, event.projectName);
  const written = formatBytesIec(event.writtenBytes);
  const threshold = formatBytesIec(event.thresholdBytes);
  const why = event.dataEngine
    ? "From a database this usually means a bulk import, a missing index forcing temp tables or runaway logging."
    : "From an app this usually means debug logging to disk, temp files piling up or data that belongs in S3/R2.";

  const hourly = ctx.series?.diskWritesHourly;
  const chart: MailBlock[] =
    hourly && hourly.length >= 2 && hourly.some((v) => v > 0)
      ? [
          { kind: "section", title: "Written per hour, last 24 hours" },
          {
            kind: "columns",
            columns: hourly.map((value) => ({ parts: [{ value, tone: (value > event.thresholdBytes ? "warn" : 2) as ChartTone }] })),
            axis: ["24 h ago", "now"],
          },
        ]
      : [];

  return {
    tone: "warn",
    status: "High disk writes",
    heading: `${ownedName(event)} wrote ${written} in ${windowPhrase(event.window)}`,
    blocks: [{ kind: "text", text: `Its threshold is ${threshold}. ${why}` }, ...chart],
    action: { label: `Open ${name}`, href: appPage(ctx, event.appId) },
    links: [{ label: "Raise the threshold", href: `${appPage(ctx, event.appId, "resources")}#edit-disk-write-threshold` }],
    footer: { ...footerFor(ctx), note: "Expected?" },
  };
}
