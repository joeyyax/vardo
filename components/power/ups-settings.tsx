"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BatteryCharging, Loader2, MoreHorizontal, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/messenger";
import type { ProbeResult } from "@/lib/ups/probe";
import { DEFAULT_ON_BATTERY_GRACE_SEC } from "@/lib/ups/status";
import { HEALTH_LABEL, HEALTH_TONE, fetchUpsServers, formatRuntime, type UpsServerView } from "./ups-format";

type FormState = {
  name: string;
  host: string;
  port: string;
  upsName: string;
  username: string;
  password: string;
  tls: boolean;
  enabled: boolean;
  graceSec: string;
};

const EMPTY_FORM: FormState = { name: "", host: "", port: "3493", upsName: "", username: "", password: "", tls: false, enabled: true, graceSec: String(DEFAULT_ON_BATTERY_GRACE_SEC) };

function toForm(s: UpsServerView): FormState {
  return { name: s.name, host: s.host, port: String(s.port), upsName: s.upsName, username: s.username ?? "", password: "", tls: s.tls, enabled: s.enabled, graceSec: String(s.onBatteryGraceSec) };
}

export function UpsSettings() {
  const [servers, setServers] = useState<UpsServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [editing, setEditing] = useState<UpsServerView | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UpsServerView | null>(null);
  const [deleting, setDeleting] = useState(false);

  function apply(list: UpsServerView[] | null) {
    if (list) {
      setServers(list);
      setError(false);
    } else setError(true);
    setLoading(false);
  }

  useEffect(() => {
    fetchUpsServers().then(apply);
  }, []);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/admin/ups/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error || "Couldn't remove the UPS");
        return;
      }
      setServers((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      toast.success(`Stopped watching ${deleteTarget.name}`);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  function onSaved(server: UpsServerView) {
    setServers((prev) => {
      const rest = prev.filter((s) => s.id !== server.id);
      return [...rest, server].sort((a, b) => a.name.localeCompare(b.name));
    });
    setEditing(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading UPS servers</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Unable to load UPS servers.</p>
        <Button variant="outline" onClick={() => { setLoading(true); fetchUpsServers().then(apply); }}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="type-h2">Power</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Watch the UPS this host runs on through its NUT server. Vardo records charge, runtime and load and alerts when power drops, the battery runs low or the UPS stops answering. It never sends commands to the UPS.
          </p>
        </div>
        <div className="flex gap-2">
          {servers.length > 0 && (
            <Button size="sm" variant="outline" asChild>
              <Link href="/admin/power">View status</Link>
            </Button>
          )}
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            Add UPS
          </Button>
        </div>
      </div>

      {servers.length === 0 ? (
        <EmptyState
          icon={BatteryCharging}
          title="No UPS watched yet"
          body="Add the NUT server your UPS reports to. upsd listens on port 3493 by default."
        />
      ) : (
        <Card variant="surface">
          <CardContent className="p-0">
            <div className="divide-y">
              {servers.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-4 px-6 py-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      {s.tls && <Badge variant="outline" className="px-1.5 py-0 text-xs">TLS</Badge>}
                      {!s.enabled && <Badge variant="neutral" className="px-1.5 py-0 text-xs">Paused</Badge>}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {s.upsName}@{s.host}:{s.port}
                      {s.username ? ` · ${s.username}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    {s.enabled && (
                      <div className="hidden text-right sm:block">
                        <StatusDot tone={HEALTH_TONE[s.health]}>{HEALTH_LABEL[s.health]}</StatusDot>
                        {s.state?.reading && (
                          <p className="text-xs text-muted-foreground tabular-nums">
                            {s.state.reading.charge ?? "—"}% · {formatRuntime(s.state.reading.runtime)}
                          </p>
                        )}
                      </div>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="size-8 shrink-0 p-0" aria-label={`Actions for ${s.name}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(s)}>
                          <Pencil className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteTarget(s)}>
                          <Trash2 className="size-4" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {editing && <UpsDialog server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={onSaved} />}

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Remove UPS"
        description={`Stop watching "${deleteTarget?.name}"? Its history is deleted and open power incidents close.`}
        onConfirm={handleDelete}
        loading={deleting}
        confirmLabel="Remove"
        loadingLabel="Removing..."
      />
    </div>
  );
}

function UpsDialog({ server, onClose, onSaved }: { server: UpsServerView | null; onClose: () => void; onSaved: (s: UpsServerView) => void }) {
  const [form, setForm] = useState<FormState>(server ? toForm(server) : EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  function connection() {
    return {
      host: form.host.trim(),
      port: Number(form.port) || 3493,
      username: form.username.trim() || null,
      tls: form.tls,
      ...(form.password ? { password: form.password } : {}),
    };
  }

  async function handleTest() {
    setTesting(true);
    setProbe(null);
    try {
      const res = await fetch("/api/v1/admin/ups/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...connection(), ...(server ? { serverId: server.id } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setProbe({ ok: false, error: json.error || "Couldn't test the connection" });
        return;
      }
      setProbe(json as ProbeResult);
      if (json.ok && json.upses.length > 0 && !form.upsName) {
        setForm((prev) => ({ ...prev, upsName: json.upses[0].name }));
      }
    } catch {
      setProbe({ ok: false, error: "Couldn't test the connection" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        ...connection(),
        name: form.name.trim() || form.upsName.trim(),
        upsName: form.upsName.trim(),
        enabled: form.enabled,
        onBatteryGraceSec: form.graceSec.trim() === "" ? DEFAULT_ON_BATTERY_GRACE_SEC : Number(form.graceSec),
      };
      const res = await fetch(server ? `/api/v1/admin/ups/${server.id}` : "/api/v1/admin/ups", {
        method: server ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Couldn't save the UPS");
        return;
      }
      toast.success(server ? `${json.server.name} updated` : `Watching ${json.server.name}`);
      onSaved(json.server);
    } catch {
      setError("Couldn't save the UPS");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{server ? `Edit ${server.name}` : "Add UPS"}</DialogTitle>
            <DialogDescription>The NUT server (upsd) your UPS reports to. Vardo only reads from it.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="space-y-2">
                <Label htmlFor="ups-host">Host</Label>
                <Input id="ups-host" value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="10.0.0.155" className="font-mono" required autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ups-port">Port</Label>
                <Input id="ups-port" value={form.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" className="font-mono" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ups-username">Username (optional)</Label>
                <Input id="ups-username" value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ups-password">Password (optional)</Label>
                <Input
                  id="ups-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder={server?.hasPassword ? "Saved; type to replace" : ""}
                  autoComplete="new-password"
                />
              </div>
            </div>

            <Card variant="inset" className="flex items-center justify-between p-3">
              <div className="space-y-0.5">
                <Label htmlFor="ups-tls" className="text-sm font-normal">Use STARTTLS</Label>
                <p className="text-xs text-muted-foreground">Encrypts the session. The server&apos;s certificate isn&apos;t verified.</p>
              </div>
              <Switch id="ups-tls" checked={form.tls} onCheckedChange={(v) => set("tls", v)} aria-label="Use STARTTLS" />
            </Card>

            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={testing || !form.host.trim()}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                Test connection
              </Button>
              {probe?.ok && <span className="text-xs text-muted-foreground">{probe.version || "Connected"}</span>}
            </div>

            {probe && !probe.ok && <p className="text-sm text-destructive">{probe.error}</p>}
            {probe?.ok && (
              <Card variant="inset" className="divide-y p-0">
                {probe.upses.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">The server lists no UPS.</p>}
                {probe.upses.map((u) => (
                  <button
                    key={u.name}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, upsName: u.name }))}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50"
                    aria-pressed={form.upsName === u.name}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-sm">{u.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {u.error ?? ([u.mfr, u.model].filter(Boolean).join(" ") || u.description)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {u.status ?? "—"}
                      {u.charge !== null && <span className="block">{u.charge}% · {formatRuntime(u.runtime)}</span>}
                    </span>
                  </button>
                ))}
              </Card>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ups-name">UPS name</Label>
                <Input id="ups-name" value={form.upsName} onChange={(e) => set("upsName", e.target.value)} placeholder="ups" className="font-mono" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ups-label">Display name</Label>
                <Input id="ups-label" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={form.upsName || "Rack UPS"} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ups-grace">On-battery grace period</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="ups-grace"
                  value={form.graceSec}
                  onChange={(e) => set("graceSec", e.target.value)}
                  inputMode="numeric"
                  className="w-24 font-mono"
                  aria-describedby="ups-grace-help"
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
              <p id="ups-grace-help" className="text-xs text-muted-foreground">
                How long the UPS stays on battery before Vardo alerts. Shorter blips are only logged. 0 alerts at once. Low battery always alerts at once.
              </p>
            </div>

            {server && (
              <Card variant="inset" className="flex items-center justify-between p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="ups-enabled" className="text-sm font-normal">Watching</Label>
                  <p className="text-xs text-muted-foreground">Paused UPSes aren&apos;t polled and don&apos;t alert.</p>
                </div>
                <Switch id="ups-enabled" checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Watching" />
              </Card>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !form.host.trim() || !form.upsName.trim()}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {server ? "Save changes" : "Add UPS"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
