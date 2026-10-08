"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Globe, Loader2, Lock } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Card } from "@/components/ui/card";

type FlagState = {
  flag: string;
  label: string;
  description: string;
  enabled: boolean;
  group: string;
  source: "env" | "config" | "database" | "default";
  locked: boolean;
  envVar: string;
  unavailable: boolean;
  dependsOn?: { flag: string; label: string };
  sharedService?: boolean;
};

type FlagGroup = {
  id: string;
  label: string;
  description: string;
};

function pinnedBy(f: FlagState) {
  return f.source === "env" ? f.envVar : "vardo.yml";
}

export function FeatureFlagsSettings() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<FlagState[]>([]);
  const [groups, setGroups] = useState<FlagGroup[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  // Per-flag write counter; the last click wins.
  const writeSeq = useRef<Record<string, number>>({});

  const fetchFlags = useCallback(async () => {
    const res = await fetch("/api/setup/feature-flags");
    if (!res.ok) throw new Error("Couldn't fetch");
    const data = await res.json();
    setFlags(data.flags ?? []);
    setGroups(data.groups ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await fetchFlags();
      } catch {
        toast.error("Couldn't load feature flags");
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchFlags]);

  async function handleToggle(flag: FlagState, next: boolean) {
    if (flag.locked || flag.unavailable) return;

    const seq = (writeSeq.current[flag.flag] ?? 0) + 1;
    writeSeq.current[flag.flag] = seq;

    setFlags((prev) => prev.map((f) => (f.flag === flag.flag ? { ...f, enabled: next } : f)));
    setPending((prev) => ({ ...prev, [flag.flag]: true }));

    let ok = false;
    let message = "";
    try {
      const res = await fetch("/api/setup/feature-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [flag.flag]: next }),
      });
      const data = await res.json().catch(() => null);
      ok = res.ok;
      message = data?.error ?? "Couldn't save that change";
    } catch {
      message = "Couldn't reach the server";
    }

    // A newer flip for this flag is in flight.
    if (writeSeq.current[flag.flag] !== seq) return;

    setPending((prev) => {
      const rest = { ...prev };
      delete rest[flag.flag];
      return rest;
    });

    if (ok) {
      toast.success(`${flag.label} ${next ? "enabled" : "disabled"}`);
      // Refetch so dependents reflect the server's view.
      if (flags.some((f) => f.dependsOn?.flag === flag.flag)) {
        await fetchFlags().catch(() => {});
      }
      router.refresh();
      return;
    }

    // Reset to server state.
    toast.error(message);
    await fetchFlags().catch(() => {
      setFlags((prev) => prev.map((f) => (f.flag === flag.flag ? { ...f, enabled: !next } : f)));
    });
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
    <div className="space-y-8">
      <div className="space-y-1">
        <h2 className="type-h2">Feature flags</h2>
        <p className="text-sm text-muted-foreground">
          Changes save as you flip them. A flag set in vardo.yml or by a{" "}
          <code className="bg-muted rounded px-1 py-0.5 text-xs">VARDO_FEATURE_*</code> env var is
          shown here but can only be changed there.
        </p>
      </div>

      {groups.map((group) => {
        const groupFlags = flags.filter((f) => f.group === group.id);
        if (groupFlags.length === 0) return null;

        return (
          <section key={group.id} className="space-y-3">
            <div className="space-y-0.5">
              <h3 className="type-h4">{group.label}</h3>
              <p className="text-xs text-muted-foreground">{group.description}</p>
            </div>

            <Card variant="surface" className="divide-y">
              {groupFlags.map((f) => (
                <div key={f.flag} className="flex items-start justify-between gap-4 p-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={`flag-${f.flag}`}>
                        {f.label}
                      </Label>
                      <Badge
                        variant={f.enabled && !f.unavailable ? "default" : "outline"}
                        className={f.enabled && !f.unavailable ? "" : "text-muted-foreground"}
                      >
                        {f.unavailable ? "Unavailable" : f.enabled ? "On" : "Off"}
                      </Badge>
                      {f.locked && (
                        <Badge variant="outline" className="gap-1 text-muted-foreground">
                          <Lock className="size-3" />
                          {pinnedBy(f)}
                        </Badge>
                      )}
                      {f.sharedService && (
                        <Badge variant="outline" className="gap-1 text-muted-foreground">
                          <Globe className="size-3" />
                          Shared service
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{f.description}</div>
                    {f.sharedService && (
                      <div className="text-xs text-muted-foreground">
                        Installs one service for the whole instance, not a copy per organization.
                        See{" "}
                        <Link href="/admin/settings/core-services" className="underline underline-offset-4">
                          Core services
                        </Link>{" "}
                        for what it installed.
                      </div>
                    )}
                    {f.unavailable && f.dependsOn && (
                      <div className="text-xs text-muted-foreground">
                        Needs {f.dependsOn.label}, which is off. Turn that on first.
                      </div>
                    )}
                    {f.locked && (
                      <div className="text-xs text-muted-foreground">
                        Pinned by {pinnedBy(f)} — change it there, then restart.
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    {pending[f.flag] && (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                    )}
                    <Switch
                      id={`flag-${f.flag}`}
                      checked={f.enabled && !f.unavailable}
                      disabled={f.locked || f.unavailable || !!pending[f.flag]}
                      onCheckedChange={(next) => handleToggle(f, next)}
                      aria-label={`${f.enabled ? "Disable" : "Enable"} ${f.label}`}
                      aria-describedby={f.locked ? `flag-${f.flag}-pinned` : undefined}
                    />
                    {f.locked && (
                      <span id={`flag-${f.flag}-pinned`} className="sr-only">
                        Pinned by {pinnedBy(f)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          </section>
        );
      })}
    </div>
  );
}
