"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUpCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Term } from "@/components/term";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/lib/messenger";
import { versionShort } from "@/lib/email/format";
import type { UpdatePolicy } from "@/lib/self-update/policy";
import type { UpdateStatus } from "@/lib/self-update/status";
import { RolloutStatus, type RolloutAction } from "./rollout-status";

const MODE_HELP: Record<UpdatePolicy["mode"], string> = {
  off: "No update notices. Update now still works.",
  notify: "Email admins when an update is out. You apply it.",
  auto: "Update when ready. Linked instances use priority order and wait for a safe moment.",
};

const RUN_LABEL: Record<string, string> = {
  deploying: "Deploying",
  verifying: "Checking health",
  "rolling-back": "Rolling back",
  verified: "Updated",
  failed: "Failed",
  "rolled-back": "Rolled back",
  "rollback-failed": "Rollback failed",
};

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

export function UpdatesCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [policy, setPolicy] = useState<UpdatePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rolloutAction, setRolloutAction] = useState<RolloutAction | null>(null);
  const [rolloutConfirmOpen, setRolloutConfirmOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const askedFromLink = useRef(false);

  async function load(fresh = false) {
    try {
      const res = await fetch(`/api/v1/admin/updates${fresh ? "?fresh=1" : ""}`);
      if (!res.ok) return;
      const data = (await res.json()) as UpdateStatus;
      setStatus(data);
      setPolicy(data.policy);
      // The update email links here with ?update=now.
      if (!askedFromLink.current && new URLSearchParams(window.location.search).get("update") === "now") {
        askedFromLink.current = true;
        setConfirmOpen(true);
      }
      const query = new URLSearchParams(window.location.search);
      if (!askedFromLink.current && query.get("action") && query.get("rollout")) {
        askedFromLink.current = true;
        const action = query.get("action");
        if (data.rollout?.id === query.get("rollout") && (action === "immediate" || action === "skip" || action === "retry")) {
          setRolloutAction({ action, instanceId: query.get("instance") ?? undefined });
          setRolloutConfirmOpen(true);
        } else {
          toast.error("This rollout has changed. Review the current plan.");
        }
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const busy = !!status?.runActive || !!status?.active;

  useEffect(() => {
    if (!busy && status?.rollout?.state !== "running") return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [busy, status?.rollout?.state]);

  async function check() {
    setChecking(true);
    await load(true);
    setChecking(false);
  }

  async function updateNow() {
    setUpdating(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/update", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't start the update");
        return;
      }
      toast.success(data.message ?? "Update started", {
        description: "The console switches over once the new one is healthy. This page reconnects on its own.",
      });
      await load();
    } catch {
      toast.error("Couldn't start the update");
    } finally {
      setUpdating(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!policy) return;
    setSaving(true);
    try {
      const res = await fetch("/api/v1/admin/updates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policy),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((data as { error?: string }).error ?? "Couldn't save the update policy");
        return;
      }
      setStatus(data as UpdateStatus);
      setPolicy((data as UpdateStatus).policy);
      toast.success("Update policy saved");
    } finally {
      setSaving(false);
    }
  }

  async function applyRolloutAction() {
    if (!rolloutAction || !status?.rollout) return;
    setActing(true);
    try {
      const response = await fetch("/api/v1/admin/updates/rollout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rolloutId: status.rollout.id, ...rolloutAction }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error((body as { error?: string }).error ?? "Couldn't change the rollout");
        return;
      }
      setRolloutConfirmOpen(false);
      toast.success(rolloutAction.action === "immediate" ? "Priority queue skipped" : rolloutAction.action === "skip" ? "Instance skipped for this rollout" : "Rollout resumed");
      await load();
    } finally {
      setActing(false);
    }
  }

  const update = status?.update;
  const run = status?.run;

  return (
    <Card id="updates" className="scroll-mt-20">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ArrowUpCircle className="size-4" aria-hidden="true" />
          Updates
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => void check()} disabled={checking || loading}>
          {checking ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-3" aria-hidden="true" />
          )}
          Check now
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading || !status || !policy ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-5 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden="true" />
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <p className="text-sm">
                Running <span className="font-mono">{status.current.version}</span>
                <span className="text-muted-foreground"> · following {status.channel === "releases" ? "releases" : "main"}</span>
              </p>

              {update?.hasUpdate ? (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary">Update available</Badge>
                  <a href={update.url} target="_blank" rel="noopener noreferrer" className="font-mono underline underline-offset-2">
                    {update.targetLabel}
                  </a>
                  {update.commitsBehind ? (
                    <span className="text-muted-foreground">
                      {update.commitsBehind} commit{update.commitsBehind === 1 ? "" : "s"} ahead
                    </span>
                  ) : null}
                </p>
              ) : update ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                  Up to date
                </p>
              ) : (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>
                    Couldn&apos;t check GitHub for updates
                    {status.checkError ? `: ${status.checkError.message}` : ""}.
                    {status.checkError?.resetsAt ? ` Checks resume ${when(status.checkError.resetsAt)}.` : ""}
                  </span>
                </p>
              )}

              {status.active && !status.runActive && (
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                  Updating Vardo{status.active.toVersion ? <> to <span className="font-mono">{versionShort(status.active.toVersion)}</span></> : null}…
                </p>
              )}

              {run && (
                <p className="text-sm text-muted-foreground">
                  {status.runActive ? "Updating" : "Last update"} to <span className="font-mono">{run.toLabel}</span> ({run.trigger}):{" "}
                  <span className="text-foreground">{RUN_LABEL[run.state] ?? run.state}</span>
                  {run.finishedAt ? ` · ${when(run.finishedAt)}` : ""}
                  {run.error ? ` · ${run.error}` : ""}
                </p>
              )}

              {status.selfDeploy ? (
                <Button
                  variant="outline"
                  onClick={() => setConfirmOpen(true)}
                  disabled={updating || busy}
                >
                  {updating || busy ? (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <ArrowUpCircle className="size-4" aria-hidden="true" />
                  )}
                  {busy ? "Updating..." : "Update now"}
                </Button>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm text-muted-foreground">This install updates from the host:</p>
                  <pre className="squircle rounded-md bg-muted px-3 py-2 font-mono text-xs">{status.hostCommand}</pre>
                </div>
              )}
            </div>

            {status.rolloutCoordinator && status.rollout && (
              <RolloutStatus rollout={status.rollout} onAction={(action) => { setRolloutAction(action); setRolloutConfirmOpen(true); }} />
            )}
            {status.rolloutCoordinator && !status.protocolReady && !status.rollout && (
              <p className="flex items-start gap-2 text-sm text-status-warning">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Automatic rollouts will start when all linked instances support the rollout protocol.
              </p>
            )}

            <form onSubmit={(e) => void save(e)} className="space-y-4 border-t pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="update-mode">
                    <Term id="update-policy">Policy</Term>
                  </Label>
                  <Select value={policy.mode} onValueChange={(v) => setPolicy({ ...policy, mode: v as UpdatePolicy["mode"] })}>
                    <SelectTrigger id="update-mode"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">
                        <Term id="update-off" passive>Off</Term>
                      </SelectItem>
                      <SelectItem value="notify">
                        <Term id="update-notify" passive>Notify</Term>
                      </SelectItem>
                      <SelectItem value="auto">
                        <Term id="update-auto" passive>Auto</Term>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{MODE_HELP[policy.mode]}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="update-channel">Channel</Label>
                  <Select
                    value={policy.channel ?? "default"}
                    onValueChange={(v) => setPolicy({ ...policy, channel: v === "default" ? null : (v as "main" | "releases") })}
                  >
                    <SelectTrigger id="update-channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default ({policy.mode === "auto" ? "releases" : "main"})</SelectItem>
                      <SelectItem value="main">Every commit on main</SelectItem>
                      <SelectItem value="releases">Releases only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="update-priority">Instance priority</Label>
                <Select value={policy.priority} onValueChange={(value) => setPolicy({ ...policy, priority: value as UpdatePolicy["priority"] })}>
                  <SelectTrigger id="update-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="critical">Critical</SelectItem>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Ready instances with higher priority update first. Busy instances don&apos;t hold the others.</p>
              </div>

              {policy.mode === "auto" && !status.selfDeploy && (
                <p className="flex items-start gap-2 text-sm text-status-warning">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Automatic updates need the self-deploy layout. Run vardo migrate-self-deploy on the host.
                </p>
              )}

              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Save policy
              </Button>
            </form>
          </>
        )}

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Update Vardo now?</AlertDialogTitle>
              <AlertDialogDescription>
                {status?.selfDeploy
                  ? `Vardo dumps its database, builds ${update?.hasUpdate ? update.targetLabel : "the latest code"} beside the running console and switches over once it's healthy. Deployed apps keep running.`
                  : `This install updates from the host. Run ${status?.hostCommand ?? "sudo vardo update"} there.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              {status?.selfDeploy && (
                <AlertDialogAction onClick={() => void updateNow()} disabled={busy}>
                  Update now
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={rolloutConfirmOpen} onOpenChange={setRolloutConfirmOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{rolloutAction?.action === "immediate" ? "Roll out to ready instances now?" : rolloutAction?.action === "skip" ? "Skip this instance?" : "Retry the rollout?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {rolloutAction?.action === "immediate"
                  ? "This skips priority order. Busy instances still wait, and health checks and concurrency limits remain in place."
                  : rolloutAction?.action === "skip"
                    ? "This instance stays on its current version for this rollout. It'll be included in the next one if still behind."
                    : "Vardo will check the affected instances again before starting another update."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void applyRolloutAction()} disabled={acting}>
                {acting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
