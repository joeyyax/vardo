// The attention row for an available Vardo update, with Update now on a self-deploy instance.

import type { AttentionRow } from "@/lib/ui/attention";
import type { ChannelUpdate } from "@/lib/version";

export const UPDATES_HREF = "/admin/settings/maintenance#updates";

export function vardoUpdateRow(input: {
  update: ChannelUpdate | null;
  currentVersion: string;
  selfDeploy: boolean;
  runActive: boolean;
}): AttentionRow | null {
  const { update } = input;
  if (input.runActive) {
    return {
      key: "vardo-update",
      label: "Vardo updating",
      tone: "activity",
      items: [{ id: "vardo-update", name: "Vardo", detail: "Update in progress", href: UPDATES_HREF }],
    };
  }
  if (!update?.hasUpdate) return null;

  const n = update.commitsBehind;
  const name =
    update.channel === "releases"
      ? `Vardo ${update.targetLabel} available`
      : `Vardo update available${n ? ` · ${n} commit${n === 1 ? "" : "s"}` : ""}`;

  return {
    key: "vardo-update",
    label: "Vardo update",
    tone: "neutral",
    items: [{ id: "vardo-update", name, href: update.url, detail: `You are on ${input.currentVersion}`, external: true }],
    footer: input.selfDeploy ? "Deployed apps keep running during the update." : "Run sudo vardo update on the host.",
    action: input.selfDeploy
      ? {
          label: "Update now",
          post: "/api/v1/admin/maintenance/update",
          confirm: {
            title: "Update Vardo now?",
            description: `Vardo dumps its database, builds ${update.targetLabel} beside the running console and switches over once it's healthy. Deployed apps keep running.`,
            label: "Update now",
          },
        }
      : { label: "Update instructions", href: UPDATES_HREF },
  };
}
