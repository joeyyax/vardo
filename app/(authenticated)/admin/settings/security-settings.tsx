"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BansList, type BanItem } from "@/components/probe-guard/bans-list";
import { guardSummary, type GuardStatsView } from "@/lib/probe-guard/summary";
import { DEFAULT_INSTANCE_PROBE_GUARD, type InstanceProbeGuard } from "@/lib/probe-guard/settings";
import { useSystemSetting } from "./use-system-setting";

const ENDPOINT = "/api/v1/admin/probe-guard";

type GuardAdminData = {
  settings: InstanceProbeGuard;
  available: boolean;
  stats: GuardStatsView;
  bans: BanItem[];
};

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SwitchRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid max-w-prose gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Instance-wide probe guard settings, counts and every active ban. */
export function SecuritySettings() {
  const [settings, setSettings] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);
  const [trapsText, setTrapsText] = useState(DEFAULT_INSTANCE_PROBE_GUARD.traps.paths.join("\n"));
  const [view, setView] = useState<Omit<GuardAdminData, "settings"> | null>(null);

  const onLoad = useCallback((data: GuardAdminData) => {
    setSettings(data.settings);
    setTrapsText(data.settings.traps.paths.join("\n"));
    setView({ available: data.available, stats: data.stats, bans: data.bans });
  }, []);

  const { loading, saving, save, refetch } = useSystemSetting<GuardAdminData>(ENDPOINT, { label: "Security settings", onLoad });

  const set = (patch: Partial<InstanceProbeGuard>) => setSettings((s) => ({ ...s, ...patch }));
  const setTraps = (patch: Partial<InstanceProbeGuard["traps"]>) => setSettings((s) => ({ ...s, traps: { ...s.traps, ...patch } }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const paths = trapsText.split("\n").map((l) => l.trim()).filter(Boolean);
    await save({ ...settings, traps: { ...settings.traps, paths } });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading security settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="type-h2">Security</h2>
        <p className="text-sm text-muted-foreground">
          {view ? guardSummary(view.stats) : "Exploit probes turned away at the proxy, and the addresses banned for them."}
        </p>
        {view && !view.available && (
          <p className="text-xs text-status-warning">Set ENCRYPTION_MASTER_KEY to turn the probe guard on.</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Probes and bans</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SwitchRow
              id="pg-humor"
              label="Humor in probe responses"
              hint="A short, friendly line instead of a bare Forbidden. Also covers the console's 404 page, robots.txt and security.txt."
              checked={settings.humor}
              onChange={(humor) => set({ humor })}
            />
            <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
              <NumberField id="pg-threshold" label="Probes before a ban" value={settings.threshold} min={2} max={100} onChange={(threshold) => set({ threshold })} />
              <NumberField id="pg-window" label="Within minutes" value={settings.windowMinutes} min={1} max={1440} onChange={(windowMinutes) => set({ windowMinutes })} />
              <NumberField id="pg-ban" label="First ban, minutes" hint="Doubles for each repeat." value={settings.banMinutes} min={5} max={1440} onChange={(banMinutes) => set({ banMinutes })} />
              <NumberField id="pg-max" label="Longest ban, hours" value={settings.maxBanHours} min={1} max={168} onChange={(maxBanHours) => set({ maxBanHours })} />
              <NumberField
                id="pg-tarpit"
                label="Delay before answering a probe, ms"
                hint="0 answers at once, like any other 403."
                value={settings.tarpitMs}
                min={0}
                max={10000}
                onChange={(tarpitMs) => set({ tarpitMs })}
              />
            </div>
            <SwitchRow
              id="pg-share"
              label="Share bans with linked instances"
              hint="New bans go to linked instances that also share, and theirs apply here until they expire. Shared bans are never passed on."
              checked={settings.shareBans}
              onChange={(shareBans) => set({ shareBans })}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Traps</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SwitchRow
              id="pg-traps"
              label="Trap paths"
              hint="Listed as Disallow in robots.txt. One request to any of them bans the address at once."
              checked={settings.traps.enabled}
              onChange={(enabled) => setTraps({ enabled })}
            />
            {settings.traps.enabled && (
              <>
                <div className="max-w-md space-y-2">
                  <Label htmlFor="pg-trap-paths">Paths</Label>
                  <Textarea id="pg-trap-paths" rows={4} className="font-mono text-xs" value={trapsText} onChange={(e) => setTrapsText(e.target.value)} />
                  <p className="text-xs text-muted-foreground">One per line. A trailing slash covers everything under it.</p>
                </div>
                <SwitchRow
                  id="pg-decoy"
                  label="Decoy .env"
                  hint="The first trap folder serves a fake .env with marked values that work nowhere. Anyone who later tries them is banned too."
                  checked={settings.traps.decoy}
                  onChange={(decoy) => setTraps({ decoy })}
                />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>security.txt</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-w-md space-y-2">
              <Label htmlFor="pg-contact">Security contact email</Label>
              <Input
                id="pg-contact"
                type="email"
                value={settings.securityContact}
                placeholder="security@example.com"
                onChange={(e) => set({ securityContact: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Published at /.well-known/security.txt on the console. Empty uses ACME_EMAIL.</p>
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Active bans</CardTitle>
        </CardHeader>
        <CardContent>
          <BansList bans={view?.bans ?? []} banUrl={(id) => `${ENDPOINT}/bans/${id}`} onChange={() => void refetch()} canBanPermanently />
        </CardContent>
      </Card>
    </div>
  );
}
