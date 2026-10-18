"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { place, xPct, gridlines, textWidth, type BarPiece, type Ghost } from "./timeline";

/** The window and clock every track draws against. */
export type Frame = { now: number; windowMs: number };

/** The deploy under the pointer or focus, so its row, bars and lane bar light up together. */
export const HoverContext = createContext<{ id: string | null; set: (id: string | null) => void }>({ id: null, set: () => {} });

export function useHover(deployId: string | null) {
  const { id, set } = useContext(HoverContext);
  return {
    lit: deployId !== null && id === deployId,
    bind:
      deployId === null
        ? {}
        : {
            onMouseEnter: () => set(deployId),
            onMouseLeave: () => set(null),
            onFocus: () => set(deployId),
            onBlur: () => set(null),
          },
  };
}

export const PIECE_CLASS: Record<BarPiece["kind"], string> = {
  queued: "h-0.5 rounded-[1px] bg-muted-foreground/60",
  prepare: "h-2.5 bg-st-prep",
  build: "h-3 bg-st-build",
  start: "h-3 bg-st-start",
  health: "h-3 bg-st-health",
  switch: "h-3 bg-st-switch",
  wait: "h-2.5 hatch-warn",
  fail: "h-3 bg-status-error",
  back: "h-3 hatch-error",
};

export const GHOST_CLASS: Record<Ghost["kind"], string> = {
  prepare: "ring-foreground/20",
  build: "ring-foreground/20",
  start: "ring-foreground/20",
  health: "ring-foreground/20",
  switch: "ring-foreground/20",
  wait: "ring-status-warning-edge",
};

/** A track: gridlines, the future hatched, the now line, then whatever is drawn on it. */
export function Track({ frame, className, children }: { frame: Frame; className?: string; children?: ReactNode }) {
  const nowX = xPct(frame.now, frame.now, frame.windowMs);
  return (
    <div className={cn("relative min-w-0 self-stretch", className)}>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {gridlines(frame.now, frame.windowMs).map((t) => (
          <i key={t.at} className="absolute inset-y-0 w-px bg-foreground/[0.06] transition-[left] duration-1000 ease-linear" style={{ left: `${t.x}%` }} />
        ))}
        <span className="track-future absolute inset-y-0 right-0" style={{ left: `${nowX}%` }} />
        <span className="absolute inset-y-0 w-[1.5px] bg-foreground/35" style={{ left: `${nowX}%` }} />
      </div>
      {children}
    </div>
  );
}

/** A span on the track at `top` px, centered. Hidden when it's outside the window. */
export function Span({
  frame,
  start,
  end,
  className,
  title,
  top,
  lit,
  label,
  labelClass,
  head,
  bind,
  style,
}: {
  frame: Frame;
  start: number;
  end: number;
  className?: string;
  title?: string;
  top?: number;
  lit?: boolean;
  label?: string;
  labelClass?: string;
  /** Draw a dot at the right end: where the deploy is now. */
  head?: "fg" | "warn" | "error";
  bind?: object;
  style?: React.CSSProperties;
}) {
  const at = place(start, end, frame.now, frame.windowMs);
  const ref = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    if (!label || !ref.current) return;
    const font = getComputedStyle(ref.current).font;
    setFits(ref.current.clientWidth >= textWidth(label, font) + 14);
  }, [label, at?.width]);
  if (!at) return null;
  return (
    <span
      ref={ref}
      title={title}
      {...bind}
      className={cn(
        "absolute -translate-y-1/2 rounded-[3px] shadow-[1px_0_0_var(--card),-1px_0_0_var(--card)] transition-[left,width] duration-1000 ease-linear",
        className,
        lit && "z-[2] ring-2 ring-brass",
      )}
      style={{ left: `${at.left}%`, width: `max(2px, ${at.width}%)`, top: top ?? "50%", ...style }}
    >
      {label ? (
        <span className={cn("pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 truncate whitespace-nowrap text-[11px] font-medium", labelClass, !fits && "invisible")}>
          {label}
        </span>
      ) : null}
      {head ? (
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 -right-1 size-1.5 -translate-y-1/2 rounded-full",
            head === "warn" ? "bg-status-warning" : head === "error" ? "bg-status-error" : "bg-foreground",
          )}
        />
      ) : null}
    </span>
  );
}

export function GhostSpan({ frame, ghost, top }: { frame: Frame; ghost: Ghost; top: number }) {
  return <Span frame={frame} start={ghost.start} end={ghost.end} top={top} title={ghost.title} className={cn("h-2.5 bg-transparent shadow-none ring-1 ring-inset", GHOST_CLASS[ghost.kind])} />;
}

/** A point mark on the track: a finish dot or a refusal. */
export function Mark({ frame, at, className, title, top }: { frame: Frame; at: number; className?: string; title?: string; top?: number | string }) {
  const x = xPct(at, frame.now, frame.windowMs);
  if (x < 0 || x > 100) return null;
  return <span title={title} className={cn("absolute -translate-x-1/2 -translate-y-1/2 transition-[left] duration-1000 ease-linear", className)} style={{ left: `${x}%`, top: top ?? "50%" }} />;
}
