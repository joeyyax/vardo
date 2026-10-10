"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";
import type { Sensitivity } from "@/lib/anomaly/signals";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_KEYS, type NotificationCategory } from "@/lib/notifications/registry";

type Settings = {
  categories: Record<NotificationCategory, boolean>;
  nightlyBackupTime: string;
  timeZone: string;
  anomalySensitivity: Sensitivity;
};

type Patch = { categories?: Partial<Record<NotificationCategory, boolean>>; nightlyBackupTime?: string; anomalySensitivity?: Sensitivity };

const SENSITIVITY_OPTIONS: { value: Sensitivity; label: string; hint: string }[] = [
  { value: "low", label: "Low", hint: "Only large, sustained jumps. Fewest alerts." },
  { value: "normal", label: "Normal", hint: "About three times an app's usual high for that hour." },
  { value: "high", label: "High", hint: "Smaller jumps too. More alerts, some of them noise." },
];

/** Every half hour, as HH:MM. */
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

function timeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

async function requestSettings(orgId: string): Promise<Settings | null> {
  try {
    const res = await fetch(`/api/v1/organizations/${orgId}/notification-settings`);
    if (!res.ok) return null;
    return (await res.json()).settings;
  } catch {
    return null;
  }
}

export function NotificationCategoriesEditor({ orgId }: { orgId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((data: Settings | null) => {
    if (data) setSettings(data);
    else setLoadError(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestSettings(orgId).then((data) => {
      if (!cancelled) apply(data);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, apply]);

  const save = useCallback(
    async (patch: Patch) => {
      setSaving(true);
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              categories: { ...prev.categories, ...patch.categories },
              nightlyBackupTime: patch.nightlyBackupTime ?? prev.nightlyBackupTime,
              anomalySensitivity: patch.anomalySensitivity ?? prev.anomalySensitivity,
            }
          : prev,
      );
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/notification-settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const d = await res.json();
        if (!res.ok) {
          toast.error(d.error || "Couldn't save notification settings");
          apply(await requestSettings(orgId));
          return;
        }
        setSettings(d.settings);
      } catch {
        toast.error("Couldn't save notification settings");
        apply(await requestSettings(orgId));
      } finally {
        setSaving(false);
      }
    },
    [orgId, apply],
  );

  if (loadError) {
    return <p className="text-sm text-destructive py-8">Couldn&apos;t load notification settings. Refresh the page and try again.</p>;
  }

  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-muted-foreground" />
            <p className="type-h3">Alerts and summaries</p>
            {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
          <p className="text-sm text-muted-foreground">
            What Vardo watches for this organization. Alerts send once, then again when they clear.
          </p>
        </div>

        <div className="space-y-3">
          {NOTIFICATION_CATEGORY_KEYS.map((key) => (
            <label key={key} className="flex items-start justify-between gap-4 cursor-pointer">
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{NOTIFICATION_CATEGORIES[key].label}</span>
                <span className="block text-xs text-muted-foreground">{NOTIFICATION_CATEGORIES[key].description}</span>
              </span>
              <Switch
                checked={settings.categories[key]}
                onCheckedChange={(checked) => save({ categories: { [key]: checked } })}
                aria-label={NOTIFICATION_CATEGORIES[key].label}
              />
            </label>
          ))}
        </div>

        {settings.categories.anomalies && (
          <div className="space-y-2 pl-6 border-l border-border">
            <Label htmlFor="anomaly-sensitivity">Unusual activity sensitivity</Label>
            <Select value={settings.anomalySensitivity} onValueChange={(v) => save({ anomalySensitivity: v as Sensitivity })}>
              <SelectTrigger id="anomaly-sensitivity" className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SENSITIVITY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {SENSITIVITY_OPTIONS.find((o) => o.value === settings.anomalySensitivity)?.hint} Each app learns its own normal over its first three days and stays quiet until then.
            </p>
          </div>
        )}

        <div className="space-y-2 pl-6 border-l border-border">
          <Label htmlFor="nightly-time">Nightly backups start at</Label>
          <Select value={settings.nightlyBackupTime} onValueChange={(v) => save({ nightlyBackupTime: v })}>
            <SelectTrigger id="nightly-time" className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...TIME_OPTIONS, settings.nightlyBackupTime])].sort().map((t) => (
                <SelectItem key={t} value={t}>
                  {timeLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            In {settings.timeZone.replace(/_/g, " ")}. Automatic backup jobs run together from this time, a few at once. Jobs with a schedule of their own keep it.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
