"use client";

import { useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listTimeZones } from "@/lib/time-zone";

/** Stands in for null: follow the parent's zone. */
export const INHERIT_ZONE = "__inherit__";

/** IANA zone picker. With `inheritLabel`, an extra first option selects null. */
export function TimeZoneSelect({
  id,
  value,
  onChange,
  inheritLabel,
  disabled,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  inheritLabel?: string;
  disabled?: boolean;
}) {
  const zones = useMemo(() => {
    const all = listTimeZones();
    return value && !all.includes(value) ? [value, ...all] : all;
  }, [value]);

  return (
    <Select
      value={value ?? INHERIT_ZONE}
      onValueChange={(v) => onChange(v === INHERIT_ZONE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full sm:w-72">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel && <SelectItem value={INHERIT_ZONE}>{inheritLabel}</SelectItem>}
        {zones.map((tz) => (
          <SelectItem key={tz} value={tz}>
            {tz.replace(/_/g, " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
