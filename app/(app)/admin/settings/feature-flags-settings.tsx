"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type FlagState = {
  flag: string;
  label: string;
  description: string;
  enabled: boolean;
  envOverride: boolean;
};

type FlagGroup = {
  title: string;
  flags: string[];
};

const FLAG_GROUPS: FlagGroup[] = [
  { title: "App features", flags: ["terminal", "environments", "backups", "cron"] },
  { title: "Authentication", flags: ["passwordAuth"] },
];

export function FeatureFlagsSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flags, setFlags] = useState<FlagState[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/setup/feature-flags");
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();
        setFlags(data.flags ?? []);
      } catch {
        // defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function toggleFlag(flag: string) {
    setFlags((prev) =>
      prev.map((f) => (f.flag === flag ? { ...f, enabled: !f.enabled } : f)),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, boolean> = {};
      for (const f of flags) {
        if (!f.envOverride) {
          payload[f.flag] = f.enabled;
        }
      }

      const res = await fetch("/api/setup/feature-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Feature flags saved");
    } catch {
      toast.error("Failed to save feature flags");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading feature flags</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Feature flags</h2>
        <p className="text-sm text-muted-foreground">
          Enable or disable features across your instance. Flags set by environment variables can&apos;t be changed here.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {FLAG_GROUPS.map((group) => {
          const groupFlags = flags.filter((f) => group.flags.includes(f.flag));
          if (groupFlags.length === 0) return null;

          return (
            <Card key={group.title} className="squircle rounded-lg">
              <CardHeader>
                <CardTitle className="text-sm">{group.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {groupFlags.map((f) => (
                  <div key={f.flag} className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`flag-${f.flag}`} className="text-sm font-medium">
                          {f.label}
                        </Label>
                        {f.envOverride && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            Set by environment variable
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{f.description}</div>
                    </div>
                    <Switch
                      id={`flag-${f.flag}`}
                      checked={f.enabled}
                      onCheckedChange={() => toggleFlag(f.flag)}
                      disabled={f.envOverride}
                      aria-label={`${f.enabled ? "Disable" : "Enable"} ${f.label}`}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}

        <Button type="submit" className="squircle" disabled={saving} aria-label="Save feature flags">
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
      </form>
    </div>
  );
}
