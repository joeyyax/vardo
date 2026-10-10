"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Term } from "@/components/term";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/messenger";
import { MEMORY_PROFILE_HINTS, type ResourceProfile } from "@/lib/ui/resource-profiles";

interface OrgResourceProfilesProps {
  orgId: string;
  memoryProfile: ResourceProfile;
  autoMaxMb: number | null;
}

export function OrgResourceProfiles({ orgId, memoryProfile: initialProfile, autoMaxMb }: OrgResourceProfilesProps) {
  const [profile, setProfile] = useState(initialProfile);
  const [max, setMax] = useState(autoMaxMb?.toString() ?? "");
  const [savedMax, setSavedMax] = useState(autoMaxMb?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't save");
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function changeProfile(next: ResourceProfile) {
    const previous = profile;
    setProfile(next);
    if (await patch({ memoryProfile: next })) toast.success("Default memory profile updated");
    else setProfile(previous);
  }

  async function saveMax(e: React.FormEvent) {
    e.preventDefault();
    const value = max.trim() ? parseInt(max, 10) : null;
    if (await patch({ memoryAutoMaxMb: value })) {
      setSavedMax(max.trim());
      toast.success("Auto ceiling saved");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Resource profiles</CardTitle>
        <CardDescription>
          How apps that pick no profile of their own treat their memory limit. CPU limits stay fixed for now.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-md space-y-2">
          <Label htmlFor="org-memory-profile">
            Default <Term id="memory-profile">memory profile</Term>
          </Label>
          <Select value={profile} onValueChange={(v) => changeProfile(v as ResourceProfile)} disabled={saving}>
            <SelectTrigger id="org-memory-profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">
              <Term id="profile-fixed" passive>Fixed</Term>
            </SelectItem>
              <SelectItem value="burstable">
              <Term id="profile-burstable" passive>Burstable</Term>
            </SelectItem>
              <SelectItem value="auto">
              <Term id="profile-auto" passive>Auto</Term>
            </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {MEMORY_PROFILE_HINTS[profile]}
            {profile === "auto" && " Apps inheriting Auto keep any limit set in Vardo or compose."}
          </p>
        </div>
        <form onSubmit={saveMax} className="max-w-md space-y-2">
          <Label htmlFor="org-memory-auto-max">Auto ceiling (MB)</Label>
          <div className="flex gap-2">
            <Input
              id="org-memory-auto-max"
              type="number"
              min="64"
              step="256"
              placeholder="No ceiling"
              value={max}
              onChange={(e) => setMax(e.target.value)}
            />
            <Button type="submit" disabled={saving || max.trim() === savedMax}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Auto never sets more than this, nor more than half the host&apos;s memory by default.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
