"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Page-level numbers. When one is pressed, the rest dim. */
export function StatGroup({
  label,
  active = false,
  children,
  className,
}: {
  label: string;
  /** One of the filters is pressed. */
  active?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-active={active}
      className={cn("group/stats -mx-3 flex flex-wrap gap-x-2.5 gap-y-1.5 max-sm:gap-x-1", className)}
    >
      {children}
    </div>
  );
}

const CELL = "squircle grid gap-0.5 rounded-md px-3 pt-2 pb-2.5 text-left";
const VALUE = "text-2xl leading-[1.1] font-semibold tracking-[-0.01em] tabular-nums max-sm:text-xl";
const UNIT = "text-sm font-normal tracking-normal text-muted-foreground";
const LABEL = "text-[13px] text-muted-foreground";

/** A number that opens the list behind it. */
export function StatFilter({
  id,
  value,
  unit,
  label,
  tone,
  pressed,
  controls,
  onPress,
}: {
  id?: string;
  value: ReactNode;
  /** Set small after the value, such as "of 40". */
  unit?: ReactNode;
  label: string;
  /** A text class for a value that is a problem. */
  tone?: string;
  pressed: boolean;
  /** Id of what it opens. */
  controls?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      aria-pressed={pressed}
      aria-controls={controls}
      data-pressed={pressed}
      onClick={onPress}
      className={cn(
        CELL,
        "cursor-pointer border border-transparent transition-[background-color,opacity] hover:bg-row-hover",
        "dark:data-[pressed=true]:border-border data-[pressed=true]:bg-card data-[pressed=true]:shadow-[var(--shadow-soft),inset_0_-2px_0_var(--brass)]",
        "group-data-[active=true]/stats:data-[pressed=false]:opacity-55",
      )}
    >
      <span className={cn(VALUE, tone)}>
        {value}
        {unit && <small className={UNIT}> {unit}</small>}
      </span>
      <span className={LABEL}>{label}</span>
    </button>
  );
}

/** A number that is only a number. */
export function Stat({ value, unit, label }: { value: ReactNode; unit?: ReactNode; label: string }) {
  return (
    <div className={cn(CELL, "group-data-[active=true]/stats:opacity-55")}>
      <span className={VALUE}>
        {value}
        {unit && <small className={UNIT}> {unit}</small>}
      </span>
      <span className={LABEL}>{label}</span>
    </div>
  );
}
