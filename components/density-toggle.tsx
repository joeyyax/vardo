"use client";

import { useCallback, useState } from "react";
import { toast } from "@/lib/messenger";
import type { UiDensity } from "@/lib/db/schema/enums";
import { cn } from "@/lib/utils";

const OPTIONS: { value: UiDensity; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "dense", label: "Dense" },
];

/** The user's density, saved to their account so it follows them across devices. */
export function useDensity(initial: UiDensity) {
  const [density, setLocal] = useState<UiDensity>(initial);

  const setDensity = useCallback(
    (next: UiDensity) => {
      const previous = density;
      setLocal(next);
      fetch("/api/v1/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ density: next }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
        })
        .catch(() => {
          setLocal(previous);
          toast.error("Couldn't save the density. It's back to how it was.");
        });
    },
    [density],
  );

  return [density, setDensity] as const;
}

export function DensityToggle({
  value,
  onChange,
  className,
}: {
  value: UiDensity;
  onChange: (density: UiDensity) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Density" className={cn("squircle inline-flex gap-0.5 rounded-md bg-accent p-[3px]", className)}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "squircle rounded-[calc(var(--radius-md)-3px)] px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground",
            "aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
