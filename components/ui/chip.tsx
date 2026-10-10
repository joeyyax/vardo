import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The one chip recipe — every status / band / meta pill renders through this
// so they read as one family: rounded-full, small semibold, tone carried by a
// soft fill. Status tones also draw an inset -edge hairline when the brand sets one.
export const chipVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-2xs font-semibold leading-[1.4]",
  {
    variants: {
      tone: {
        // Status ramp — warm fills, calm text per Quiet Canvas.
        issue: "bg-danger-soft text-danger inset-ring inset-ring-danger-edge",
        warn: "bg-warning-soft text-warning inset-ring inset-ring-warning-edge",
        good: "bg-success-soft text-success-ink inset-ring inset-ring-success-edge",
        info: "bg-info-soft text-info-ink inset-ring inset-ring-info-edge",
        // Neutral metadata.
        neutral: "bg-secondary text-tertiary",
        // Measured values — mono for data.
        value: "bg-muted font-mono tabular-nums text-muted-foreground",
        // Cobalt tint — a true signal.
        signal: "bg-accent text-primary-strong",
      },
      // Small caps suit a one-word status. A sentence, a date or an address set in them is
      // harder to read, so anything interpolated turns them off.
      caps: {
        true: "type-smallcaps tracking-[0.08em]",
        false: null,
      },
    },
    defaultVariants: { tone: "neutral", caps: true },
  },
);

export type ChipTone = NonNullable<VariantProps<typeof chipVariants>["tone"]>;

export function Chip({
  tone,
  caps,
  className,
  children,
  title,
}: VariantProps<typeof chipVariants> & {
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  // Mono values are already a different voice; small caps on top of it reads as a third.
  const smallcaps = caps ?? tone !== "value";

  return (
    <span className={cn(chipVariants({ tone, caps: smallcaps }), className)} title={title}>
      {children}
    </span>
  );
}
