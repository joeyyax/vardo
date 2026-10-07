import { cn } from "@/lib/utils";

/** Announces one "Loading…" for a group of skeleton bars. */
export function SkeletonGroup({
  label = "Loading…",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" className={cn(className)}>
      {children}
      <span className="sr-only">{label}</span>
    </div>
  );
}
