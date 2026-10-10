import { describeEol } from "@/lib/docker/image-updates/eol";
import type { ResurfaceReason } from "@/lib/docker/image-updates/majors";
import type { MajorNotice } from "@/lib/docker/image-updates/status";
import type { AttentionRow } from "@/lib/ui/attention";

/** One sentence per reason, plus the newest major when there is one. */
export function describeMajorNotice(service: MajorNotice["service"]): string {
  const parts = service.reasons.map(describeReason);
  if (service.majorAvailable) parts.push(`${service.majorAvailable} is out.`);
  return parts.join(" ");
}

function describeReason(reason: ResurfaceReason): string {
  return reason.kind === "eol"
    ? describeEol(reason.notice)
    : `${reason.advisory.summary} Fixed in ${reason.advisory.fixedIn}.`;
}

/** Running majors that need a decision now, whatever their track policy. */
export function majorNoticeRows(notices: MajorNotice[]): AttentionRow[] {
  if (notices.length === 0) return [];
  return [
    {
      key: "image-major-eol",
      label: "End of life",
      tone: "warning",
      group: "lifecycle",
      items: notices.map(({ appId, name, displayName, service }) => ({
        id: `${appId}:${service.service ?? ""}`,
        subject: appId,
        name: service.service ? `${displayName} · ${service.service}` : displayName,
        href: `/apps/${name}/updates`,
        detail: describeMajorNotice(service),
        tone: service.reasons.some((r) => r.kind === "eol" && r.notice.state === "ended")
          ? "error"
          : "warning",
        urgent: false,
      })),
      footer: "Back up first. Plan upgrade walks through the migration.",
      action: { label: "Review major versions", href: "/updates#major-versions" },
    },
  ];
}
