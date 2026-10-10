import { cn } from "@/lib/utils";

/**
 * The elbow joining a nested row to the row above it. Fills a `relative` host's height.
 * `last` ends the line at the elbow; otherwise it runs on to the next sibling. `dashed` marks a link
 * that isn't containment, such as a separate app a row depends on.
 */
export function TreeConnector({
  last = true,
  dashed = false,
  className,
}: {
  last?: boolean;
  dashed?: boolean;
  className?: string;
}) {
  const line = cn("border-muted-foreground/35", dashed && "border-dashed");
  return (
    <span aria-hidden="true" className={cn("pointer-events-none absolute inset-y-0 w-2.5", className)}>
      <span className={cn("absolute left-0 top-0 h-1/2 w-full rounded-bl-[4px] border-b border-l", line)} />
      {!last && <span className={cn("absolute bottom-0 left-0 top-1/2 border-l", line)} />}
    </span>
  );
}
