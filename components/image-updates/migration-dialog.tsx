"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { planMigration, type MigrationPlan } from "@/lib/docker/image-updates/migration-path";
import type { ServiceUpdate } from "./update-row";

export type MigrationPrompt = {
  /** App the service belongs to. */
  appId: string;
  appName: string;
  entry: ServiceUpdate;
  tag: string;
};

/**
 * Runs the backup the migration steps ask for, rather than only naming it.
 * Git-sourced apps still need this — the code is in git, the data is not.
 */
function BackupBeforeMigration({ orgId, appId }: { orgId: string; appId: string }) {
  const [state, setState] = useState<"idle" | "running" | "started" | "unavailable">("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [gitSourced, setGitSourced] = useState(false);

  async function backup() {
    setState("running");
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/backup-now`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await res.json();
      if (!res.ok) {
        // NO_VOLUMES and BIND_MOUNTS_ONLY are answers, not failures.
        setState("unavailable");
        setDetail(body.error ?? "Could not start a backup");
        return;
      }
      setGitSourced(Boolean(body.assessment?.gitSourced));
      setDetail((body.warnings ?? []).join(" ") || null);
      setState("started");
    } catch {
      setState("unavailable");
      setDetail("Could not reach the backup service");
    }
  }

  if (state === "started") {
    return (
      <p className="type-body-sm rounded-md border border-status-success/30 bg-status-success-muted/30 p-2.5 text-muted-foreground">
        <span className="text-status-success">Backup started.</span> Track it on the Backups tab
        before continuing.
        {gitSourced && " Code is in git; this captures the data volumes."}
        {detail ? ` ${detail}` : ""}
      </p>
    );
  }

  if (state === "unavailable") {
    return (
      <p className="type-body-sm rounded-md border border-status-warning/30 bg-status-warning-muted/30 p-2.5 text-status-warning">
        {detail} — back up by hand before continuing.
      </p>
    );
  }

  return (
    <Button variant="outline" className="w-full" disabled={state === "running"} onClick={backup}>
      {state === "running" ? "Starting backup…" : "Back up now"}
    </Button>
  );
}

/**
 * Shown when a pick crosses a major on an image whose data directory is tied to
 * that major. The deploy would fail on the version check, so the recipe comes
 * before the confirm rather than after the outage.
 */
export function MigrationDialog(props: {
  prompt: MigrationPrompt | null;
  orgId: string;
  /** Plan the API returned. Falls back to the one computed here. */
  plan?: MigrationPlan | null;
  onClose: () => void;
  onConfirm: (prompt: MigrationPrompt) => void;
}) {
  const { prompt } = props;
  if (!prompt) return null;
  // Keyed per prompt so the acknowledgement never carries over to another row.
  return (
    <MigrationBody
      {...props}
      prompt={prompt}
      key={`${prompt.appId}:${prompt.entry.service}:${prompt.tag}`}
    />
  );
}

function MigrationBody({
  prompt,
  orgId,
  plan: serverPlan,
  onClose,
  onConfirm,
}: {
  prompt: MigrationPrompt;
  orgId: string;
  plan?: MigrationPlan | null;
  onClose: () => void;
  onConfirm: (prompt: MigrationPrompt) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { entry, tag, appId } = prompt;
  const plan = serverPlan ?? planMigration(entry.image, entry.currentTag, tag);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-status-warning" aria-hidden="true" />
            {entry.currentTag} → {tag} is a data migration
          </DialogTitle>
          <DialogDescription>
            {plan?.engine ?? entry.image} stores data in a format tied to its major version. Pinning
            this tag alone will not start — the new container refuses the existing data directory.
          </DialogDescription>
        </DialogHeader>

        {plan?.needsIntermediateSteps && (
          <p className="text-sm text-status-warning">
            {plan.engine} cannot jump straight there. Land on {plan.hops.join(", then ")} in order.
          </p>
        )}

        {plan && (
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            {plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}

        <BackupBeforeMigration orgId={orgId} appId={appId} />

        <label className="flex items-start gap-2.5 text-sm text-muted-foreground">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
            className="mt-0.5"
          />
          <span>
            I have a backup and will run the migration above. {prompt.appName} stays down until it
            completes.
          </span>
        </label>

        <DialogFooter className="sm:justify-between">
          {plan && (
            <a
              href={plan.docs}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground underline self-center"
            >
              Upstream upgrade notes
            </a>
          )}
          <span className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!acknowledged}
              onClick={() => onConfirm(prompt)}
            >
              Pin {tag}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
