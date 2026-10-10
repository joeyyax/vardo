"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Term } from "@/components/term";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MEMORY_PROFILE_HINTS, type ResourceProfile } from "@/lib/ui/resource-profiles";

export type MemoryProfileChoice = ResourceProfile | "inherit";

export type MemoryProfileValues = {
  profile: MemoryProfileChoice;
  reservation: string;
  autoMin: string;
  autoMax: string;
};

/** The memory profile select, its per-profile fields and the limit in force. */
export function MemoryProfileFields({
  orgId,
  appId,
  values,
  onChange,
}: {
  orgId: string;
  appId: string;
  values: MemoryProfileValues;
  onChange: (next: MemoryProfileValues) => void;
}) {
  const [why, setWhy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/apps/${appId}/resource-profile`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.memory) return;
        const limit = data.memory.limitMb ? `${data.memory.limitMb} MB` : "No limit";
        setWhy(`${limit}: ${data.memory.why}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId, appId]);

  const set = (patch: Partial<MemoryProfileValues>) => onChange({ ...values, ...patch });

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 sm:w-1/2">
        <Label htmlFor="edit-memory-profile">
          <Term id="memory-profile">Memory profile</Term>
        </Label>
        <Select value={values.profile} onValueChange={(v) => set({ profile: v as MemoryProfileChoice })}>
          <SelectTrigger id="edit-memory-profile">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">Organization default</SelectItem>
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
          {values.profile === "inherit"
            ? "Uses the organization's profile. An inherited Auto keeps any limit set here or in compose."
            : MEMORY_PROFILE_HINTS[values.profile]}
        </p>
      </div>

      {values.profile === "burstable" && (
        <div className="grid gap-2 sm:w-1/2">
          <Label htmlFor="edit-memory-reservation">Guaranteed memory (MB)</Label>
          <Input id="edit-memory-reservation" type="number" step="64" min="64" placeholder="Half the limit" value={values.reservation} onChange={(e) => set({ reservation: e.target.value })} />
          <p className="text-xs text-muted-foreground">The memory limit above is the ceiling it bursts to.</p>
        </div>
      )}

      {values.profile === "auto" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="edit-memory-auto-min">Auto floor (MB)</Label>
            <Input id="edit-memory-auto-min" type="number" step="64" min="64" placeholder="Tier default" value={values.autoMin} onChange={(e) => set({ autoMin: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-memory-auto-max">Auto ceiling (MB)</Label>
            <Input id="edit-memory-auto-max" type="number" step="64" min="64" placeholder="Organization ceiling" value={values.autoMax} onChange={(e) => set({ autoMax: e.target.value })} />
          </div>
        </div>
      )}

      {why && <p className="text-xs text-muted-foreground">Now: {why}</p>}
    </div>
  );
}
