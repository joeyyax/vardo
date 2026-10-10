"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "@/lib/messenger";
import { Loader2 } from "lucide-react";
import { TimeZoneSelect } from "@/components/time-zone-select";

interface OrgGeneralSettingsProps {
  orgId: string;
  orgName: string;
  orgTimeZone: string | null;
  instanceTimeZone: string;
  githubFeedback: boolean;
}

export function OrgGeneralSettings({ orgId, orgName, orgTimeZone, instanceTimeZone, githubFeedback: initialFeedback }: OrgGeneralSettingsProps) {
  const [githubFeedback, setGithubFeedback] = useState(initialFeedback);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [timeZone, setTimeZone] = useState(orgTimeZone);
  const [savingZone, setSavingZone] = useState(false);
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
        throw new Error(data.error ?? "Couldn't save");
      }

      setSavedName(trimmed);
      toast.success("Organization name updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function saveTimeZone(next: string | null) {
    const previous = timeZone;
    setTimeZone(next);
    setSavingZone(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZone: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't save");
      }
      toast.success("Time zone updated");
    } catch (err) {
      setTimeZone(previous);
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSavingZone(false);
    }
  }

  async function saveGithubFeedback(next: boolean) {
    setGithubFeedback(next);
    setSavingFeedback(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubFeedback: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't save");
      }
      toast.success(next ? "GitHub deploy status on" : "GitHub deploy status off");
    } catch (err) {
      setGithubFeedback(!next);
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSavingFeedback(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle as="h2">General</CardTitle>
          <CardDescription>The organization name appears in the sidebar, team invitations and notification emails.</CardDescription>
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
              disabled={!isDirty || saving || !name.trim()}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle as="h2">Time zone</CardTitle>
          <CardDescription>
            Nightly backups, digests and the times in emails use this zone. Cron jobs pick their own.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="org-time-zone">Time zone</Label>
          <TimeZoneSelect
            id="org-time-zone"
            value={timeZone}
            onChange={saveTimeZone}
            inheritLabel={`Instance default (${instanceTimeZone.replace(/_/g, " ")})`}
            disabled={savingZone}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle as="h2">GitHub</CardTitle>
          <CardDescription>
            The default for apps deployed from a GitHub App repo. Each app can override it in its build settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="org-github-feedback"
              checked={githubFeedback}
              onCheckedChange={saveGithubFeedback}
              disabled={savingFeedback}
            />
            <div className="grid gap-0.5">
              <Label htmlFor="org-github-feedback">Post deploy status to GitHub</Label>
              <p className="text-xs text-muted-foreground">
                Commit statuses, deployments and a preview comment on pull requests.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
