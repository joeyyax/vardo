import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type SystemBadgeProps = {
  label?: string;
  compact?: boolean;
  className?: string;
};

/**
 * Marks a project, stack or app that Vardo manages itself. Appears in project
 * cards, project headers and app headers — one label everywhere.
 *
 * Thin wrapper around Badge using status-warning design tokens for consistency
 * with the rest of the status color system.
 */
export function SystemBadge({ label = "System Managed", compact = false, className }: SystemBadgeProps) {
  return (
    <Badge
      variant="warning"
      className={cn(compact ? "px-2 py-0.5" : "px-2.5 py-1", className)}
    >
      {label}
    </Badge>
  );
}
