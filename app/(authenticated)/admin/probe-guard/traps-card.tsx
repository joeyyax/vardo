"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSystemSetting } from "@/app/(authenticated)/admin/settings/use-system-setting";
import { DEFAULT_INSTANCE_PROBE_GUARD, type InstanceProbeGuard } from "@/lib/probe-guard/settings";

const ENDPOINT = "/api/v1/admin/probe-guard";

type Data = { settings: InstanceProbeGuard; configured?: boolean };

/** Trap paths that ban the address on first hit, plus the decoy .env file. */
export function TrapsCard() {
  const [settings, setSettings] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);
  const [baseline, setBaseline] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);
  const [pathsText, setPathsText] = useState(DEFAULT_INSTANCE_PROBE_GUARD.traps.paths.join("\n"));

  const onLoad = useCallback((data: Data) => {
    setSettings(data.settings);
    setBaseline(data.settings);
    setPathsText(data.settings.traps.paths.join("\n"));
  }, []);

  const { loading, saving, save } = useSystemSetting<Data>(ENDPOINT, { label: "Traps", onLoad });

  const setTraps = (patch: Partial<InstanceProbeGuard["traps"]>) => setSettings((s) => ({ ...s, traps: { ...s.traps, ...patch } }));

  const parsedPaths = pathsText.split("\n").map((l) => l.trim()).filter(Boolean);
  const dirty =
    settings.traps.enabled !== baseline.traps.enabled ||
    settings.traps.decoy !== baseline.traps.decoy ||
    JSON.stringify(parsedPaths) !== JSON.stringify(baseline.traps.paths);

  if (loading) {
    return (
      <Card id="traps" variant="surface">
        <CardContent className="py-6 flex justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="traps" variant="surface">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>Traps</CardTitle>
            <p className="text-xs text-muted-foreground">One request to a trap path bans the address at once.</p>
          </div>
          <Switch checked={settings.traps.enabled} onCheckedChange={(enabled) => setTraps({ enabled })} aria-label="Traps" />
        </div>
      </CardHeader>
      {settings.traps.enabled && (
        <CardContent className="space-y-4">
          <div className="max-w-md space-y-2">
            <Label htmlFor="pg-trap-paths">Paths</Label>
            <Textarea id="pg-trap-paths" rows={4} className="font-mono text-xs" value={pathsText} onChange={(e) => setPathsText(e.target.value)} />
            <p className="text-xs text-muted-foreground">One per line. Also listed as Disallow in robots.txt. A trailing slash covers everything under it.</p>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md bg-muted/40 px-3 py-2">
            <div className="grid max-w-prose gap-0.5">
              <Label htmlFor="pg-decoy">Decoy .env</Label>
              <p className="text-xs text-muted-foreground">The first trap folder serves a fake .env with marked values. Anyone who later tries them is banned too.</p>
            </div>
            <Switch id="pg-decoy" checked={settings.traps.decoy} onCheckedChange={(decoy) => setTraps({ decoy })} />
          </div>
          <div className="flex items-center justify-between border-t pt-3">
            <span className={`text-xs ${dirty ? "text-status-warning" : "text-muted-foreground"}`}>{dirty ? "Unsaved changes" : "Saved"}</span>
            <Button
              size="sm"
              disabled={saving || !dirty}
              onClick={() => {
                const patch = { traps: { enabled: settings.traps.enabled, decoy: settings.traps.decoy, paths: parsedPaths } };
                const next = { ...settings, traps: { ...settings.traps, paths: parsedPaths } };
                setBaseline(next);
                void save(patch as unknown as Record<string, unknown>);
              }}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}