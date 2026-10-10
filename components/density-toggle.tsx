"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "@/lib/messenger";
import type { UiDensity } from "@/lib/db/schema/enums";
import { cn } from "@/lib/utils";

const OPTIONS: { value: UiDensity; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "dense", label: "Dense" },
];

type Anchor = { key: string; top: number };

/** The row to hold still: the focused one, else the hovered one, else the first in view. */
function findAnchor(): Anchor | null {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-nav]")];
  const row =
    (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-nav]") ??
    rows.find((r) => r.matches(":hover")) ??
    rows.find((r) => r.getBoundingClientRect().top >= 0);
  return row?.dataset.nav ? { key: row.dataset.nav, top: row.getBoundingClientRect().top } : null;
}

/**
 * The user's density, saved to their account so it follows them across devices. A switch keeps
 * the anchor row where it was on screen.
 */
export function useDensity(initial: UiDensity) {
  const [density, setLocal] = useState<UiDensity>(initial);
  const anchor = useRef<Anchor | null>(null);

  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a) return;
    const row = document.querySelector<HTMLElement>(`[data-nav="${CSS.escape(a.key)}"]`);
    if (row) window.scrollBy(0, row.getBoundingClientRect().top - a.top);
  }, [density]);

  const setDensity = useCallback(
    (next: UiDensity) => {
      const previous = density;
      if (next === previous) return;
      anchor.current = findAnchor();
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
