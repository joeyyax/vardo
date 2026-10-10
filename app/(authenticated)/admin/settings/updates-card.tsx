"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowUpCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { UpdatePolicy } from "@/lib/self-update/policy";
import type { UpdateStatus } from "@/lib/self-update/status";

const MODE_HELP: Record<UpdatePolicy["mode"], string> = {
  off: "No update notices. Update now still works.",
  notify: "Email admins when an update is out. You apply it.",
  auto: "Apply updates in the maintenance window after pre-flight checks, with a database dump first.",
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

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function UpdatesCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [policy, setPolicy] = useState<UpdatePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const zoneList = useMemo(() => zones(), []);
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
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!status?.runActive) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [status?.runActive]);

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

  async function approve(sha: string) {
    const res = await fetch("/api/v1/admin/updates/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha }),
    });
    if (!res.ok) {
      toast.error("Couldn't approve the update");
      return;
    }
    toast.success(`Approved ${short(sha)}. It applies in the next maintenance window.`);
    await load();
  }

  const update = status?.update;
  const run = status?.run;
  const zonePlaceholder = status?.instanceTimezone ?? "UTC";

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
                <p className="text-sm text-muted-foreground">Couldn&apos;t check GitHub for updates.</p>
              )}

              {run && (
                <p className="text-sm text-muted-foreground">
                  {status.runActive ? "Updating" : "Last update"} to <span className="font-mono">{run.toLabel}</span> ({run.trigger}):{" "}
                  <span className="text-foreground">{RUN_LABEL[run.state] ?? run.state}</span>
                  {run.finishedAt ? ` · ${when(run.finishedAt)}` : ""}
                  {run.error ? ` · ${run.error}` : ""}
                </p>
              )}

              {status.canary && !status.canary.ready && update?.hasUpdate && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-status-warning">{status.canary.reason}</span>
                  <Button variant="outline" size="sm" onClick={() => void approve(update.targetSha)}>
                    Approve {update.targetLabel}
                  </Button>
                </div>
              )}

              {status.selfDeploy ? (
                <Button
                  variant="outline"
                  onClick={() => setConfirmOpen(true)}
                  disabled={updating || status.runActive}
                >
                  {updating || status.runActive ? (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <ArrowUpCircle className="size-4" aria-hidden="true" />
                  )}
                  {status.runActive ? "Updating..." : "Update now"}
                </Button>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm text-muted-foreground">This install updates from the host:</p>
                  <pre className="squircle rounded-md bg-muted px-3 py-2 font-mono text-xs">{status.hostCommand}</pre>
                </div>
              )}
            </div>

            <form onSubmit={(e) => void save(e)} className="space-y-4 border-t pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="update-mode">Policy</Label>
                  <Select value={policy.mode} onValueChange={(v) => setPolicy({ ...policy, mode: v as UpdatePolicy["mode"] })}>
                    <SelectTrigger id="update-mode"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="notify">Notify</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
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

              {policy.mode === "auto" && !status.selfDeploy && (
                <p className="flex items-start gap-2 text-sm text-status-warning">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Automatic updates need the self-deploy layout. Run vardo migrate-self-deploy on the host.
                </p>
              )}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Maintenance window</legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="window-start" className="text-xs text-muted-foreground">Start</Label>
                    <Input id="window-start" type="time" value={policy.window.start} onChange={(e) => setPolicy({ ...policy, window: { ...policy.window, start: e.target.value } })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="window-end" className="text-xs text-muted-foreground">End</Label>
                    <Input id="window-end" type="time" value={policy.window.end} onChange={(e) => setPolicy({ ...policy, window: { ...policy.window, end: e.target.value } })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="window-tz" className="text-xs text-muted-foreground">Time zone</Label>
                    <Input
                      id="window-tz"
                      list="window-tz-list"
                      placeholder={status.instanceTimezone ? `${zonePlaceholder} (instance)` : browserZone()}
                      value={policy.window.timezone ?? ""}
                      onChange={(e) => setPolicy({ ...policy, window: { ...policy.window, timezone: e.target.value || null } })}
                    />
                    <datalist id="window-tz-list">
                      {zoneList.map((z) => <option key={z} value={z} />)}
                    </datalist>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {status.windowOpen ? "The window is open now" : status.nextWindowAt ? `Next opens ${when(status.nextWindowAt)}` : ""} ({status.zone}).
                  {" "}Auto only starts inside it.
                </p>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Linked instances</legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="canary-role" className="text-xs text-muted-foreground">Role</Label>
                    <Select
                      value={policy.canary.role}
                      onValueChange={(v) => setPolicy({ ...policy, canary: { ...policy.canary, role: v as UpdatePolicy["canary"]["role"] } })}
                    >
                      <SelectTrigger id="canary-role"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Independent</SelectItem>
                        <SelectItem value="canary">Canary: updates first</SelectItem>
                        <SelectItem value="follower">Follows a canary</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {policy.canary.role === "follower" && (
                    <>
                      <div className="space-y-1">
                        <Label htmlFor="canary-peer" className="text-xs text-muted-foreground">Canary</Label>
                        <Select
                          value={policy.canary.canaryInstanceId ?? ""}
                          onValueChange={(v) => setPolicy({ ...policy, canary: { ...policy.canary, canaryInstanceId: v || null } })}
                        >
                          <SelectTrigger id="canary-peer"><SelectValue placeholder="Pick an instance" /></SelectTrigger>
                          <SelectContent>
                            {status.peers.map((p) => (
                              <SelectItem key={p.instanceId} value={p.instanceId}>
                                {p.name} {p.sha ? `(${short(p.sha)})` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="canary-soak" className="text-xs text-muted-foreground">Healthy for (hours)</Label>
                        <Input
                          id="canary-soak"
                          type="number"
                          min={0}
                          max={336}
                          value={policy.canary.soakHours}
                          onChange={(e) => setPolicy({ ...policy, canary: { ...policy.canary, soakHours: Number(e.target.value) || 0 } })}
                        />
                      </div>
                    </>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  A follower takes a version once the canary has run it healthy this long, or once you approve it here.
                </p>
              </fieldset>

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
                <AlertDialogAction onClick={() => void updateNow()} disabled={status.runActive}>
                  Update now
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
