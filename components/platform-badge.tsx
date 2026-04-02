import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type PlatformBadgeProps = {
  compact?: boolean;
  className?: string;
};

/**
 * Badge for apps backing a platform integration (metrics, error tracking, etc.).
 * Uses the primary/blue design tokens to distinguish from system-managed (amber).
 */
export function PlatformBadge({ compact = false, className }: PlatformBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-primary/30 bg-primary/10 text-primary",
        compact ? "px-2 py-0.5" : "px-2.5 py-1",
        className
      )}
    >
      Platform
    </Badge>
  );
}
