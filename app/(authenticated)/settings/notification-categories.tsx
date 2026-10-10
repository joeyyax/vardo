"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_KEYS, type NotificationCategory } from "@/lib/notifications/registry";

type Settings = {
  categories: Record<NotificationCategory, boolean>;
  batchWindowMinutes: number;
};

const WINDOW_OPTIONS = [15, 30, 60, 120, 240];

function windowLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
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
    async (patch: { categories?: Partial<Record<NotificationCategory, boolean>>; batchWindowMinutes?: number }) => {
      setSaving(true);
      setSettings((prev) =>
        prev ? { categories: { ...prev.categories, ...patch.categories }, batchWindowMinutes: patch.batchWindowMinutes ?? prev.batchWindowMinutes } : prev,
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

        <div className="space-y-2 pl-6 border-l border-border">
          <Label htmlFor="batch-window">Backup batch window</Label>
          <Select value={String(settings.batchWindowMinutes)} onValueChange={(v) => save({ batchWindowMinutes: parseInt(v) })}>
            <SelectTrigger id="batch-window" className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...WINDOW_OPTIONS, settings.batchWindowMinutes])].sort((a, b) => a - b).map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {windowLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Results within this long of the first one go out in one email, sooner once every scheduled job is done. A failure
            sends within 5 minutes.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
