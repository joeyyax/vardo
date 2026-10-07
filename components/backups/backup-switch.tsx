"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useCan } from "@/components/capabilities-provider";
import { toast } from "@/lib/messenger";

type Source = "app" | "org" | "system";

type AppSwitchState = {
  enabled: boolean;
  source: Source;
  setting: boolean | null;
  status: "covered" | "no-target" | "uncovered" | "off";
};

type OrgDefaultState = {
  enabled: boolean;
  source: Source;
  setting: boolean | null;
};

const FROM: Record<Source, string> = {
  app: "",
  org: ", from org default",
  system: ", from system default",
};

const HINT: Record<AppSwitchState["status"], string | null> = {
  covered: null,
  "no-target": "Add a storage target to start backing up.",
  uncovered: "Nothing selected to back up yet.",
  off: "Existing backups are kept.",
};

export function switchSummary(state: { enabled: boolean; source: Source; status?: AppSwitchState["status"] }) {
  if (state.enabled && state.status === "no-target") return "On, no target";
  return `${state.enabled ? "On" : "Off"}${FROM[state.source]}`;
}

async function readJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** PUT a setting; returns the new state, or null after a toast. */
async function writeJson<T>(url: string, enabled: boolean | null): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(body?.error ?? "Could not save");
      return null;
    }
    return body as T;
  } catch {
    toast.error("Could not save");
    return null;
  }
}

function SwitchRow({
  id,
  label,
  summary,
  hint,
  checked,
  disabled,
  inherited,
  resetLabel,
  onChange,
}: {
  id: string;
  label: string;
  summary: string;
  hint?: string | null;
  checked: boolean;
  disabled: boolean;
  inherited: boolean;
  resetLabel?: string;
  onChange: (enabled: boolean | null) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-sm text-muted-foreground">
          {summary}
          {hint ? `. ${hint}` : null}
        </p>
        {!inherited && resetLabel && !disabled ? (
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onChange(null)}>
            {resetLabel}
          </Button>
        ) : null}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v)} />
    </div>
  );
}

/** The app's backup switch, for its Backups tab. */
export function AppBackupSwitch({ orgId, appId }: { orgId: string; appId: string }) {
  const can = useCan();
  const [state, setState] = useState<AppSwitchState | null>(null);
  const [saving, setSaving] = useState(false);
  const url = `/api/v1/organizations/${orgId}/apps/${appId}/backup-switch`;

  useEffect(() => {
    readJson<AppSwitchState>(url).then(setState);
  }, [url]);

  const change = useCallback(
    async (enabled: boolean | null) => {
      setSaving(true);
      const next = await writeJson<AppSwitchState>(url, enabled);
      if (next) setState(next);
      setSaving(false);
    },
    [url],
  );

  if (!state) return null;

  return (
    <SwitchRow
      id={`backup-switch-${appId}`}
      label="Back up this app"
      summary={switchSummary(state)}
      hint={HINT[state.status]}
      checked={state.enabled}
      disabled={saving || !can("backup.jobs.manage")}
      inherited={state.setting === null}
      resetLabel="Use default"
      onChange={change}
    />
  );
}

/** The org's default for apps without a setting of their own. */
export function OrgBackupDefault({ orgId, heading = "h3" }: { orgId: string; heading?: "h2" | "h3" }) {
  const can = useCan();
  const [state, setState] = useState<OrgDefaultState | null>(null);
  const [saving, setSaving] = useState(false);
  const url = `/api/v1/organizations/${orgId}/backups/default`;

  useEffect(() => {
    readJson<OrgDefaultState>(url).then(setState);
  }, [url]);

  const change = useCallback(
    async (enabled: boolean | null) => {
      setSaving(true);
      const next = await writeJson<OrgDefaultState>(url, enabled);
      if (next) {
        setState(next);
        toast.success("Backup default saved");
      }
      setSaving(false);
    },
    [url],
  );

  if (!state) return null;

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle as={heading}>Default for apps</CardTitle>
      </CardHeader>
      <CardContent>
        <SwitchRow
          id="org-backup-default"
          label="Back up apps"
          summary={`${state.enabled ? "On" : "Off"}${state.setting === null ? FROM.system : ""}. Applies to apps without their own setting`}
          checked={state.enabled}
          disabled={saving || !can("backup.jobs.manage")}
          inherited={state.setting === null}
          resetLabel="Use system default"
          onChange={change}
        />
      </CardContent>
    </Card>
  );
}

/** The instance default, for admin settings. */
export function SystemBackupDefault({ heading = "h3" }: { heading?: "h2" | "h3" }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const url = "/api/v1/admin/backup-default";

  useEffect(() => {
    readJson<{ enabled: boolean }>(url).then((s) => setEnabled(s?.enabled ?? null));
  }, []);

  const change = useCallback(async (next: boolean | null) => {
    if (next === null) return;
    setSaving(true);
    const saved = await writeJson<{ enabled: boolean }>(url, next);
    if (saved) {
      setEnabled(saved.enabled);
      toast.success("Backup default saved");
    }
    setSaving(false);
  }, []);

  if (enabled === null) return null;

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle as={heading}>Default for apps</CardTitle>
      </CardHeader>
      <CardContent>
        <SwitchRow
          id="system-backup-default"
          label="Back up apps"
          summary={`${enabled ? "On" : "Off"}. Applies to orgs and apps without their own setting`}
          checked={enabled}
          disabled={saving}
          inherited
          onChange={change}
        />
      </CardContent>
    </Card>
  );
}
