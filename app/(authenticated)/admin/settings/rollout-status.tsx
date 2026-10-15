"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Rollout, RolloutMember } from "@/lib/self-update/rollout-plan";

export type RolloutAction = { action: "immediate" | "skip" | "retry" | "dismiss"; instanceId?: string };

const STATE_LABELS: Record<RolloutMember["state"], string> = {
  waiting: "Waiting", busy: "Busy", updating: "Updating", verified: "Updated",
  skipped: "Skipped", failed: "Failed", unreachable: "Unreachable",
};

const PRIORITY_LABELS: Record<RolloutMember["priority"], string> = {
  critical: "Critical", standard: "Standard", low: "Low",
};

export function RolloutStatus({ rollout, unlinked = [], onAction }: { rollout: Rollout; unlinked?: string[]; onAction: (action: RolloutAction) => void }) {
  const updated = rollout.members.filter((member) => member.state === "verified").length;
  return (
    <section aria-label="Instance rollout" className="space-y-4 border-t pt-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Instance rollout · {rollout.targetLabel}</p>
          <p className="text-xs text-muted-foreground">
            {rollout.state === "running" ? `${updated} of ${rollout.members.length} updated` : rollout.state === "paused" ? "Paused until an admin acts" : rollout.state === "completed" ? "Finished" : "Superseded by a newer release"}
            {rollout.immediate ? " · priority queue skipped" : ""}
          </p>
        </div>
        {rollout.state === "running" && !rollout.immediate && (
          <Button variant="outline" size="sm" onClick={() => onAction({ action: "immediate" })}>Roll out everywhere now</Button>
        )}
        {rollout.state === "paused" && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onAction({ action: "retry" })}>Retry rollout</Button>
            <Button variant="ghost" size="sm" onClick={() => onAction({ action: "dismiss" })}>Dismiss rollout</Button>
          </div>
        )}
      </div>
      <ul className="divide-y rounded-lg border">
        {rollout.members.map((member) => (
          <li key={member.instanceId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{member.name}</span>
                <span className="text-xs text-muted-foreground">{PRIORITY_LABELS[member.priority]}</span>
                <Badge variant="secondary">{STATE_LABELS[member.state]}</Badge>
              </div>
              {member.reason && <p className="mt-1 text-xs text-muted-foreground">{member.reason}</p>}
            </div>
            {member.state === "busy" && rollout.state === "running" && (
              <Button variant="ghost" size="sm" onClick={() => onAction({ action: "skip", instanceId: member.instanceId })}>Skip this rollout</Button>
            )}
            {unlinked.includes(member.instanceId) && (
              <Button variant="ghost" size="sm" onClick={() => onAction({ action: "skip", instanceId: member.instanceId })}>Remove from rollout</Button>
            )}
          </li>
        ))}
      </ul>
      {rollout.members.some((member) => member.state === "skipped") && (
        <p className="text-xs text-muted-foreground">Skipped instances remain on the older version and join the next rollout if still behind.</p>
      )}
    </section>
  );
}
