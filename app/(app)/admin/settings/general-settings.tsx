"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useSystemSetting } from "./use-system-setting";
import { DEFAULT_APP_NAME } from "@/lib/system-settings";

export function GeneralSettings() {
  const [instanceName, setInstanceName] = useState(DEFAULT_APP_NAME);

  const onLoad = useCallback(
    (data: Record<string, unknown>) => {
      setInstanceName((data.instanceName as string) || DEFAULT_APP_NAME);
    },
    [],
  );

  const { loading, saving, save } = useSystemSetting("/api/setup/general", {
    label: "General settings",
    onLoad,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save({ instanceName });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading general settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">General</h2>
        <p className="text-sm text-muted-foreground">
          Basic instance configuration like your app name.
        </p>
      </div>

      <Card className="squircle rounded-lg">
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="max-w-md space-y-2">
              <Label htmlFor="sys-instance-name">Instance name</Label>
              <Input
                id="sys-instance-name"
                value={instanceName}
                onChange={(e) => setInstanceName(e.target.value)}
                placeholder={DEFAULT_APP_NAME}
                required
              />
              <p className="text-xs text-muted-foreground">
                Displayed in the browser tab and system emails.
              </p>
            </div>

            <Button type="submit" className="squircle" disabled={saving} aria-label="Save general settings">
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
