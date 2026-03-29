"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "@/lib/messenger";
import { Loader2 } from "lucide-react";

interface OrgGeneralSettingsProps {
  orgId: string;
  orgName: string;
  trusted: boolean;
}

export function OrgGeneralSettings({ orgId, orgName, trusted: initialTrusted }: OrgGeneralSettingsProps) {
  const [name, setName] = useState(orgName);
  const [savedName, setSavedName] = useState(orgName);
  const [saving, setSaving] = useState(false);
  const [trusted, setTrusted] = useState(initialTrusted);
  const [savingTrusted, setSavingTrusted] = useState(false);

  const isDirty = name.trim() !== savedName;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = name.trim();
    if (!trimmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save");
      }

      setSavedName(trimmed);
      toast.success("Organization name updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleTrustedChange(value: boolean) {
    setTrusted(value);
    setSavingTrusted(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trusted: value }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save");
      }

      toast.success(value ? "Trusted environment enabled" : "Trusted environment disabled");
    } catch (err) {
      setTrusted(!value);
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingTrusted(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="squircle rounded-lg">
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>The organization name appears in the sidebar, team invitations, and notification emails.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="org-name">Organization name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Organization"
                maxLength={64}
                required
              />
            </div>

            <Button
              type="submit"
              className="squircle"
              disabled={!isDirty || saving || !name.trim()}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="squircle rounded-lg">
        <CardHeader>
          <CardTitle>Trusted environment</CardTitle>
          <CardDescription>
            When enabled, all mount restrictions are removed. Bind mounts, docker socket, /dev, and other host paths are allowed as configured. Recommended for self-hosted installs. Disable for multi-tenant or shared environments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="org-trusted"
              checked={trusted}
              onCheckedChange={handleTrustedChange}
              disabled={savingTrusted}
            />
            <Label htmlFor="org-trusted" className="cursor-pointer">
              {trusted ? "Enabled — no mount restrictions" : "Disabled — standard sanitization applies"}
            </Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
