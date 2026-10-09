import type { VolumeDriftEvent } from "@/lib/bus/events";
import { plural } from "../format";
import type { NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

export function volumeDriftMail(event: VolumeDriftEvent, ctx: MailContext): NotificationMailBody {
  const volumes = (event.volumes ?? []).filter((v) => v.modified + v.added + v.missing > 0);

  return {
    tone: "warn",
    status: "Volume drift",
    heading: `${event.appName}'s volumes differ from its image`,
    preheader: `${plural(event.totalDrift, "file")} changed since the image was built`,
    paragraphs: [
      `${plural(event.totalDrift, "file")} in persistent volumes no longer match the image. A redeploy won't reset them.`,
      "Review the changes, then ignore the expected paths or restore the files.",
    ],
    facts: [{ label: "Changed files", value: String(event.totalDrift) }],
    sections: volumes.length
      ? [
          {
            title: "By volume",
            facts: volumes.map((v) => ({
              label: v.name,
              value: [v.modified && `${v.modified} modified`, v.added && `${v.added} added`, v.missing && `${v.missing} missing`]
                .filter(Boolean)
                .join(", "),
            })),
          },
        ]
      : undefined,
    action: { label: "Review volumes", href: appPage(ctx, event.appId, "volumes") },
    footer: footerFor(ctx),
  };
}
