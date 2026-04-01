"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { ADMIN_FLAGS } from "@/lib/config/admin-flags";

type FlagState = {
  flag: string;
  label: string;
  description: string;
  enabled: boolean;
};

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
        payload[f.flag] = f.enabled;
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
          Enable or disable features across your instance.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {flags
          .filter((f) => (ADMIN_FLAGS as readonly string[]).includes(f.flag))
          .map((f) => (
            <div key={f.flag} className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor={`flag-${f.flag}`} className="text-sm font-medium">
                  {f.label}
                </Label>
                <div className="text-xs text-muted-foreground">{f.description}</div>
              </div>
              <Switch
                id={`flag-${f.flag}`}
                checked={f.enabled}
                onCheckedChange={() => toggleFlag(f.flag)}
                aria-label={`${f.enabled ? "Disable" : "Enable"} ${f.label}`}
              />
            </div>
          ))}

        <Button type="submit" className="squircle" disabled={saving} aria-label="Save feature flags">
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
      </form>
    </div>
  );
}
