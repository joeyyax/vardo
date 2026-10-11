// The attention row for an available Vardo update, with Update now on a self-deploy instance, or the one running.

import type { AttentionRow } from "@/lib/ui/attention";
import type { ChannelUpdate } from "@/lib/version";
import type { ActiveUpdate } from "@/lib/self-update/lifecycle";
import { versionShort } from "@/lib/email/format";

export const UPDATES_HREF = "/admin/settings/maintenance#updates";

/** The row the "updating" banner reads. */
export const VARDO_UPDATING_ROW_KEY = "vardo-updating";

/** "Updating Vardo to 4f1a9b2…" while an update runs. */
export function vardoUpdatingRow(active: Pick<ActiveUpdate, "id" | "toVersion" | "startedAt"> | null): AttentionRow {
  return {
    key: VARDO_UPDATING_ROW_KEY,
    label: "Vardo updating",
    tone: "activity",
    items: [
      {
        id: active?.id ?? "vardo-updating",
        name: `Updating Vardo${active?.toVersion ? ` to ${versionShort(active.toVersion)}` : ""}…`,
        detail: "In progress",
        href: UPDATES_HREF,
        ...(active ? { since: new Date(active.startedAt).toISOString() } : {}),
      },
    ],
    footer: "Deployed apps keep running. This clears when the update finishes or fails.",
  };
}

export function vardoUpdateRow(input: {
  update: ChannelUpdate | null;
  currentVersion: string;
  selfDeploy: boolean;
  runActive: boolean;
}): AttentionRow | null {
  const { update } = input;
  if (input.runActive) return vardoUpdatingRow(null);
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
