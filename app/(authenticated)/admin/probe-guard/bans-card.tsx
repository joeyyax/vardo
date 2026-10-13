"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSystemSetting } from "@/app/(authenticated)/admin/settings/use-system-setting";
import { DEFAULT_INSTANCE_PROBE_GUARD, type InstanceProbeGuard } from "@/lib/probe-guard/settings";

const ENDPOINT = "/api/v1/admin/probe-guard";

type Data = { settings: InstanceProbeGuard; configured?: boolean };

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
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Threshold, window, first and longest ban, share bans. Apps opt out but can't change these. */
export function BansCard() {
  const [settings, setSettings] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);
  const [baseline, setBaseline] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);

  const onLoad = useCallback((data: Data) => {
    setSettings(data.settings);
    setBaseline(data.settings);
  }, []);

  const { loading, saving, save } = useSystemSetting<Data>(ENDPOINT, { label: "Bans", onLoad });

  const setField = (patch: Partial<InstanceProbeGuard>) => setSettings((s) => ({ ...s, ...patch }));

  const dirty =
    settings.threshold !== baseline.threshold ||
    settings.windowMinutes !== baseline.windowMinutes ||
    settings.banMinutes !== baseline.banMinutes ||
    settings.maxBanHours !== baseline.maxBanHours ||
    settings.shareBans !== baseline.shareBans;

  if (loading) {
    return (
      <Card id="bans" variant="surface">
        <CardContent className="py-6 flex justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="bans" variant="surface">
      <CardHeader>
        <div className="space-y-1">
          <CardTitle>Bans</CardTitle>
          <p className="text-xs text-muted-foreground">When an address is banned and for how long. Apps can opt out, not change these.</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <NumberField id="pg-threshold" label="Probes before a ban" value={settings.threshold} min={2} max={100} onChange={(threshold) => setField({ threshold })} />
          <NumberField id="pg-window" label="Within minutes" value={settings.windowMinutes} min={1} max={1440} onChange={(windowMinutes) => setField({ windowMinutes })} />
          <NumberField id="pg-ban" label="First ban, minutes" hint="Doubles for each repeat." value={settings.banMinutes} min={5} max={1440} onChange={(banMinutes) => setField({ banMinutes })} />
          <NumberField id="pg-max" label="Longest ban, hours" value={settings.maxBanHours} min={1} max={168} onChange={(maxBanHours) => setField({ maxBanHours })} />
        </div>
        <div className="flex items-start justify-between gap-4 rounded-md bg-muted/40 px-3 py-2">
          <div className="grid max-w-prose gap-0.5">
            <Label htmlFor="pg-share">Share bans with linked instances</Label>
            <p className="text-xs text-muted-foreground">New bans go to linked instances that also share, and theirs apply here until they expire. Shared bans are never passed on.</p>
          </div>
          <Switch id="pg-share" checked={settings.shareBans} onCheckedChange={(shareBans) => setField({ shareBans })} />
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <span className={`text-xs ${dirty ? "text-status-warning" : "text-muted-foreground"}`}>{dirty ? "Unsaved changes" : "Saved"}</span>
          <Button
            size="sm"
            disabled={saving || !dirty}
            onClick={() => {
              const patch = {
                threshold: settings.threshold,
                windowMinutes: settings.windowMinutes,
                banMinutes: settings.banMinutes,
                maxBanHours: settings.maxBanHours,
                shareBans: settings.shareBans,
              };
              setBaseline(settings);
              void save(patch as unknown as Record<string, unknown>);
            }}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}