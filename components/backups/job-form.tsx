"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { SCHEDULE_PRESETS } from "./constants";
import type { App, BackupTarget } from "./types";

export function JobForm({
  open,
  onOpenChange,
  orgId,
  targets,
  apps,
  defaultTargetId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  targets: BackupTarget[];
  apps: App[];
  defaultTargetId?: string;
  onCreated: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState(defaultTargetId || "");
  const [schedule, setSchedule] = useState("0 2 * * *");
  const [appIds, setAppIds] = useState<string[]>([]);

  // Retention
  const [keepLast, setKeepLast] = useState("1");
  const [keepDaily, setKeepDaily] = useState("7");
  const [keepWeekly, setKeepWeekly] = useState("4");
  const [keepMonthly, setKeepMonthly] = useState("6");

  function reset() {
    setName("");
    setTargetId(defaultTargetId || "");
    setSchedule("0 2 * * *");
    setAppIds([]);
    setKeepLast("1");
    setKeepDaily("7");
    setKeepWeekly("4");
    setKeepMonthly("6");
  }

  function toggleApp(appId: string) {
    setAppIds((prev) =>
      prev.includes(appId) ? prev.filter((id) => id !== appId) : [...prev, appId]
    );
  }

  async function handleCreate() {
    if (!name.trim() || !targetId || appIds.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          targetId,
          appIds,
          schedule,
          keepLast: keepLast ? parseInt(keepLast, 10) : null,
          keepDaily: keepDaily ? parseInt(keepDaily, 10) : null,
          keepWeekly: keepWeekly ? parseInt(keepWeekly, 10) : null,
          keepMonthly: keepMonthly ? parseInt(keepMonthly, 10) : null,
        }),
      });
      if (res.ok) {
        toast.success("Backup job created");
        onOpenChange(false);
        reset();
        onCreated();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to create job");
      }
    } catch {
      toast.error("Failed to create job");
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent>
        <BottomSheetHeader>
          <BottomSheetTitle>New backup job</BottomSheetTitle>
          <BottomSheetDescription>
            Configure a scheduled backup for your apps. Select a storage target, schedule, and retention policy.
          </BottomSheetDescription>
        </BottomSheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="job-name">Name</Label>
              <Input id="job-name" placeholder="Daily database backup" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="grid gap-2">
              <Label>Storage target</Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger><SelectValue placeholder="Select a target" /></SelectTrigger>
                <SelectContent>
                  {targets.filter((t) => !t.isAppLevel).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name} ({t.type})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label>Schedule</Label>
              <Select value={schedule} onValueChange={setSchedule}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>{preset.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label className="text-sm font-medium">Retention</Label>
              <p className="text-xs text-muted-foreground">
                How many snapshots to keep at each tier. Older backups are pruned automatically.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="keep-last" className="text-xs text-muted-foreground">Keep last</Label>
                  <Input id="keep-last" type="number" min="0" value={keepLast} onChange={(e) => setKeepLast(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="keep-daily" className="text-xs text-muted-foreground">Keep daily</Label>
                  <Input id="keep-daily" type="number" min="0" value={keepDaily} onChange={(e) => setKeepDaily(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="keep-weekly" className="text-xs text-muted-foreground">Keep weekly</Label>
                  <Input id="keep-weekly" type="number" min="0" value={keepWeekly} onChange={(e) => setKeepWeekly(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="keep-monthly" className="text-xs text-muted-foreground">Keep monthly</Label>
                  <Input id="keep-monthly" type="number" min="0" value={keepMonthly} onChange={(e) => setKeepMonthly(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Apps to back up</Label>
              <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border p-2">
                {apps.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">No apps available</p>
                ) : (
                  apps.map((app) => (
                    <label key={app.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appIds.includes(app.id)}
                        onChange={() => toggleApp(app.id)}
                        className="size-4 rounded border-input"
                      />
                      <span className="text-sm">{app.displayName}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <BottomSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving || !name.trim() || !targetId || appIds.length === 0}>
            {saving ? <><Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />Creating...</> : "Create job"}
          </Button>
        </BottomSheetFooter>
      </BottomSheetContent>
    </BottomSheet>
  );
}
