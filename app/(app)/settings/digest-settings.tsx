"use client";

import { useState, useEffect, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { notify } from "@/lib/notify";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Mail } from "lucide-react";

type DigestSettingsData = {
  enabled: boolean;
  dayOfWeek: number;
  hourOfDay: number;
  lastSentAt: string | null;
};

const DAY_LABELS: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const HOUR_LABELS: Record<number, string> = Object.fromEntries(
  Array.from({ length: 24 }, (_, i) => {
    const h = i % 12 || 12;
    const ampm = i < 12 ? "AM" : "PM";
    return [i, `${h}:00 ${ampm} UTC`];
  }),
);

export function DigestSettingsEditor({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<DigestSettingsData>({
    enabled: false,
    dayOfWeek: 1,
    hourOfDay: 8,
    lastSentAt: null,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/digest`);
      if (res.ok) {
        const d = await res.json();
        setSettings(d.digestSettings);
        setLoadError(false);
      } else {
        setLoadError(true);
        notify.toast.error("Failed to load digest settings");
      }
    } catch {
      setLoadError(true);
      notify.toast.error("Failed to load digest settings");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (patch: Partial<DigestSettingsData>) => {
      setSaving(true);
      // Optimistically update
      setSettings((prev) => ({ ...prev, ...patch }));
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/digest`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const d = await res.json();
          notify.toast.error(d.error || "Failed to save digest settings");
          // Revert optimistic update
          load();
          return;
        }
        const d = await res.json();
        setSettings(d.digestSettings);
      } catch {
        notify.toast.error("Failed to save digest settings");
        load();
      } finally {
        setSaving(false);
      }
    },
    [orgId, load],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
      </div>
    );
  }

  if (loadError) {
    return (
      <p className="text-sm text-destructive py-8">
        Could not load digest settings. Please refresh the page and try again.
      </p>
    );
  }

  return (
    <Card className="squircle rounded-lg">
      <CardContent className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">Weekly Digest</p>
            {saving && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Receive a weekly summary of deploys, backups, cron failures, and
            alerts across all your projects. Sent to all enabled email
            notification channels.
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(checked) => save({ enabled: checked })}
          aria-label="Enable weekly digest"
        />
      </div>

      {settings.enabled && (
        <div className="space-y-3 pl-6 border-l border-border">
          <p className="text-xs text-muted-foreground">
            Schedule times are in UTC.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="digest-day">Day of week</Label>
              <Select
                value={String(settings.dayOfWeek)}
                onValueChange={(v) => save({ dayOfWeek: parseInt(v) })}
              >
                <SelectTrigger id="digest-day" className="squircle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DAY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="digest-hour">Time (UTC)</Label>
              <Select
                value={String(settings.hourOfDay)}
                onValueChange={(v) => save({ hourOfDay: parseInt(v) })}
              >
                <SelectTrigger id="digest-hour" className="squircle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(HOUR_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {settings.lastSentAt && (
        <p className="text-xs text-muted-foreground">
          Last sent{" "}
          {new Date(settings.lastSentAt).toLocaleDateString("en-US", {
            weekday: "long",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          })}
        </p>
      )}
      </CardContent>
    </Card>
  );
}
