import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Expand/collapse indicator: points right when closed, rotates 90° when open.
 * Pass `open` for state-driven toggles; inside a Radix trigger (`group`) or a
 * `<details class="group">` it follows the parent's open state.
 */
export function DisclosureChevron({
  open,
  className,
}: {
  open?: boolean;
  className?: string;
}) {
  return (
    <ChevronRight
      aria-hidden="true"
      data-slot="disclosure-chevron"
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 group-open:rotate-90",
        open && "rotate-90",
        className
      )}
    />
  );
}
