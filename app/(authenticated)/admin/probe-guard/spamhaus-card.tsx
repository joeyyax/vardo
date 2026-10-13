"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useSystemSetting } from "@/app/(authenticated)/admin/settings/use-system-setting";
import { DEFAULT_ABUSE_SETTINGS, type AbuseSettings } from "@/lib/probe-guard/abuse-settings";

const ENDPOINT = "/api/v1/admin/probe-guard/abuse";

type Data = { settings: AbuseSettings; configured?: boolean };

/** Spamhaus DROP ranges. Fetched daily; ranges overlapping Never ban are skipped. */
export function SpamhausCard() {
  const [settings, setSettings] = useState<AbuseSettings>(DEFAULT_ABUSE_SETTINGS);
  const [baseline, setBaseline] = useState<AbuseSettings>(DEFAULT_ABUSE_SETTINGS);

  const onLoad = useCallback((data: Data) => {
    setSettings(data.settings);
    setBaseline(data.settings);
  }, []);

  const { loading, saving, save } = useSystemSetting<Data>(ENDPOINT, { label: "Spamhaus", onLoad });

  const dirty = settings.blocklists.spamhaus.enabled !== baseline.blocklists.spamhaus.enabled;

  if (loading) {
    return (
      <Card id="spamhaus" variant="surface">
        <CardContent className="py-6 flex justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="spamhaus" variant="surface">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>Spamhaus DROP</CardTitle>
            <p className="text-xs text-muted-foreground">Hijacked and criminal networks, fetched daily. Ranges overlapping Never ban are skipped.</p>
          </div>
          <Switch
            aria-label="Spamhaus DROP"
            checked={settings.blocklists.spamhaus.enabled}
            onCheckedChange={(enabled) => setSettings((s) => ({ ...s, blocklists: { ...s.blocklists, spamhaus: { enabled } } }))}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between border-t pt-3">
          <span className={`text-xs ${dirty ? "text-status-warning" : "text-muted-foreground"}`}>{dirty ? "Unsaved changes" : "Saved"}</span>
          <Button
            size="sm"
            disabled={saving || !dirty}
            onClick={() => {
              const patch = { blocklists: { spamhaus: settings.blocklists.spamhaus } };
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