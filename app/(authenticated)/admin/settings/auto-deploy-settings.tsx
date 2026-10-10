"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSystemSetting } from "./use-system-setting";

const CHOICES = [0, 1, 2, 5, 10, 15, 30, 60];

const label = (minutes: number) => (minutes === 0 ? "Off" : minutes === 60 ? "Every hour" : `Every ${minutes} min`);

/** Instance-wide poll interval for auto-deploy apps. */
export function AutoDeploySettings() {
  const [minutes, setMinutes] = useState(5);

  const onLoad = useCallback((data: Record<string, unknown>) => {
    if (typeof data.pollIntervalMinutes === "number") setMinutes(data.pollIntervalMinutes);
  }, []);

  const { loading, saving, save } = useSystemSetting("/api/v1/admin/auto-deploy", {
    label: "Auto-deploy settings",
    onLoad,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto deploy</CardTitle>
        <CardDescription>
          Checks each auto-deploy app&apos;s branch for new commits, for pushes a webhook or relay missed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save({ pollIntervalMinutes: minutes });
          }}
        >
          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-poll-interval">Check for new commits</Label>
            <Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))} disabled={loading}>
              <SelectTrigger id="sys-poll-interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHOICES.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {label(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Uses each app&apos;s own GitHub App token or deploy key. A failed commit isn&apos;t retried until the branch moves.
            </p>
          </div>
          <Button type="submit" disabled={saving || loading} aria-label="Save auto-deploy settings">
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
