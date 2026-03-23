"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

interface OrgGeneralSettingsProps {
  orgId: string;
  orgName: string;
}

export function OrgGeneralSettings({ orgId, orgName }: OrgGeneralSettingsProps) {
  const [name, setName] = useState(orgName);
  const [savedName, setSavedName] = useState(orgName);
  const [saving, setSaving] = useState(false);

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

  return (
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
  );
}
