import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type SystemBadgeProps = {
  label?: string;
  compact?: boolean;
  className?: string;
};

/**
 * Amber badge used to identify system-managed projects and apps. Appears in
 * project cards, project detail headers, and app detail headers.
 *
 * Thin wrapper around Badge using status-warning design tokens for consistency
 * with the rest of the status color system.
 */
export function SystemBadge({ label = "System", compact = false, className }: SystemBadgeProps) {
  return (
    <Badge
      className={cn(
        "border-status-warning/30 bg-status-warning-muted text-status-warning",
        compact ? "px-2 py-0.5" : "px-2.5 py-1",
        className
      )}
    >
      {label}
    </Badge>
  );
}
