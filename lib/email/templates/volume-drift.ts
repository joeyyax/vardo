import type { VolumeDriftEvent } from "@/lib/bus/events";
import { plural, possessive } from "../format";
import type { NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

export function volumeDriftMail(event: VolumeDriftEvent, ctx: MailContext): NotificationMailBody {
  const volumes = (event.volumes ?? []).filter((v) => v.modified + v.added + v.missing > 0);
  const files = plural(event.totalDrift, "file");

  return {
    tone: "warn",
    status: "Volume drift",
    heading: `${files} in ${possessive(event.appName)} volumes changed`,
    blocks: [
      {
        kind: "text",
        text: `${event.totalDrift === 1 ? "It no longer matches" : "They no longer match"} the image, and a redeploy won't reset ${event.totalDrift === 1 ? "it" : "them"}. Review ${event.totalDrift === 1 ? "it" : "them"}, then ignore the expected paths or restore the files.`,
      },
      ...(volumes.length
        ? [
            {
              kind: "stats" as const,
              columns: ["Volume", "Modified", "Added", "Missing"],
              rows: volumes.map((v) => ({
                name: v.name,
                cells: [String(v.modified), String(v.added), { value: String(v.missing), hot: v.missing > 0 }],
              })),
            },
          ]
        : []),
    ],
    action: { label: "Review the changes", href: appPage(ctx, event.appId, "volumes") },
    footer: footerFor(ctx),
  };
}
