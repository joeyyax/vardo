"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";
import type { PowerPolicies } from "@/lib/power/settings";

type Draft = Omit<PowerPolicies, "stopAfterMinutes" | "stopBelowCharge"> & { stopAfterMinutes: string; stopBelowCharge: string };

function toDraft(p: PowerPolicies): Draft {
  return { ...p, stopAfterMinutes: p.stopAfterMinutes?.toString() ?? "", stopBelowCharge: p.stopBelowCharge?.toString() ?? "" };
}

function fromDraft(d: Draft): PowerPolicies {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return { ...d, stopAfterMinutes: num(d.stopAfterMinutes), stopBelowCharge: num(d.stopBelowCharge) };
}

/** Why the draft can't save, or null. */
function problemOf(p: PowerPolicies): string | null {
  if (p.stopAfterMinutes !== null && (!Number.isInteger(p.stopAfterMinutes) || p.stopAfterMinutes < 1 || p.stopAfterMinutes > 1440)) return "Minutes must be a whole number from 1 to 1440.";
  if (p.stopBelowCharge !== null && (!Number.isInteger(p.stopBelowCharge) || p.stopBelowCharge < 1 || p.stopBelowCharge > 99)) return "Charge must be a whole percent from 1 to 99.";
  if (p.stopApps && p.stopAfterMinutes === null && p.stopBelowCharge === null) return "Set minutes on battery, a charge level or both.";
  return null;
}

function PolicyRow({ id, label, checked, onChange, children }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-6 py-4">
      <Switch id={id} className="mt-0.5" checked={checked} onCheckedChange={onChange} />
      <div className="grid min-w-0 flex-1 gap-1">
        <Label htmlFor={id}>{label}</Label>
        {children}
      </div>
    </div>
  );
}

export function PowerPolicySettings() {
  const [saved, setSaved] = useState<PowerPolicies | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [monitored, setMonitored] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/v1/admin/power/policies")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { policies: PowerPolicies; monitored: boolean }) => {
        setSaved(data.policies);
        setDraft(toDraft(data.policies));
        setMonitored(data.monitored);
      })
      .catch(() => setError(true));
  }, []);

  if (error) return <p className="text-sm text-muted-foreground">Unable to load power policies.</p>;
  if (!draft || !saved) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading power policies</span>
      </div>
    );
  }

  const next = fromDraft(draft);
  const problem = problemOf(next);
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/admin/power/policies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Couldn't save the power policies");
        return;
      }
      setSaved(data.policies);
      setDraft(toDraft(data.policies));
      toast.success("Power policies saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="power-policies-heading">
      <div className="space-y-1">
        <h3 id="power-policies-heading" className="type-h3">On battery</h3>
        <p className="max-w-2xl text-sm text-muted-foreground">
          What Vardo does when the host runs on UPS power. It lightens its own load and never shuts down the host; the host&apos;s NUT client does that.
        </p>
      </div>

      {!monitored && (
        <Callout variant="info">These policies act once a UPS is added. Until then, and whenever its readings go stale, they do nothing.</Callout>
      )}

      <Card variant="surface" className="divide-y">
        <PolicyRow id="policy-skip-backups" label="Skip scheduled backups" checked={draft.skipBackups} onChange={(v) => set({ skipBackups: v })}>
          <p className="text-xs text-muted-foreground">
            A scheduled backup due on battery is skipped and runs at its next time on mains. Backups already running finish. Backups started by hand still run.
          </p>
        </PolicyRow>
        <PolicyRow id="policy-hold-deploys" label="Hold new deploys" checked={draft.holdDeploys} onChange={(v) => set({ holdDeploys: v })}>
          <p className="text-xs text-muted-foreground">
            New deploys wait in the queue until power is back. Builds already running finish, and rollbacks and restarts aren&apos;t held. An admin can start a held deploy anyway.
          </p>
        </PolicyRow>
        <PolicyRow id="policy-stop-apps" label="Stop apps" checked={draft.stopApps} onChange={(v) => set({ stopApps: v })}>
          <p className="text-xs text-muted-foreground">
            Stops apps lowest priority first, whichever limit comes first. Apps set to keep running on battery and Vardo&apos;s own services stay up. Once power has been back for 2 minutes, Vardo restarts the apps it stopped and only those.
          </p>
          <div className="mt-2 flex flex-wrap gap-4">
            <div className="grid gap-1">
              <Label htmlFor="policy-stop-minutes" className="text-xs font-normal text-muted-foreground">After minutes on battery</Label>
              <Input
                id="policy-stop-minutes"
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                placeholder="Off"
                className="h-8 w-28 tabular-nums"
                value={draft.stopAfterMinutes}
                disabled={!draft.stopApps}
                onChange={(e) => set({ stopAfterMinutes: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="policy-stop-charge" className="text-xs font-normal text-muted-foreground">At or below charge (%)</Label>
              <Input
                id="policy-stop-charge"
                type="number"
                inputMode="numeric"
                min={1}
                max={99}
                placeholder="Off"
                className="h-8 w-28 tabular-nums"
                value={draft.stopBelowCharge}
                disabled={!draft.stopApps}
                onChange={(e) => set({ stopBelowCharge: e.target.value })}
              />
            </div>
          </div>
        </PolicyRow>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={!dirty || !!problem || saving} onClick={() => void save()}>
          {saving ? <Loader2 className="animate-spin" /> : "Save"}
        </Button>
        {problem && (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
    </section>
  );
}
