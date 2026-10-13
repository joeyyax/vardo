"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSystemSetting } from "@/app/(authenticated)/admin/settings/use-system-setting";
import { DEFAULT_INSTANCE_PROBE_GUARD, type InstanceProbeGuard } from "@/lib/probe-guard/settings";

const ENDPOINT = "/api/v1/admin/probe-guard";

type Data = { settings: InstanceProbeGuard; configured?: boolean };

/** The contact published at /.well-known/security.txt. Empty falls back to ACME_EMAIL. */
export function DisclosureCard() {
  const [settings, setSettings] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);
  const [baseline, setBaseline] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);

  const onLoad = useCallback((data: Data) => {
    setSettings(data.settings);
    setBaseline(data.settings);
  }, []);

  const { loading, saving, save } = useSystemSetting<Data>(ENDPOINT, { label: "Disclosure", onLoad });

  const dirty = settings.securityContact !== baseline.securityContact;

  if (loading) {
    return (
      <Card id="disclosure" variant="surface">
        <CardContent className="py-6 flex justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="disclosure" variant="surface">
      <CardHeader>
        <CardTitle>Disclosure</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-w-md space-y-2">
          <Label htmlFor="pg-contact">Security contact</Label>
          <Input
            id="pg-contact"
            type="email"
            value={settings.securityContact}
            placeholder="security@example.com"
            onChange={(e) => setSettings((s) => ({ ...s, securityContact: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">Published at /.well-known/security.txt. Empty uses ACME_EMAIL.</p>
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <span className={`text-xs ${dirty ? "text-status-warning" : "text-muted-foreground"}`}>{dirty ? "Unsaved changes" : "Saved"}</span>
          <Button
            size="sm"
            disabled={saving || !dirty}
            onClick={() => {
              const patch = { securityContact: settings.securityContact };
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