type SystemBadgeProps = {
  label?: string;
  compact?: boolean;
  className?: string;
};

/**
 * Amber badge used to identify system-managed projects and apps. Appears in
 * project cards, project detail headers, and app detail headers.
 */
export function SystemBadge({ label = "System", compact = false, className }: SystemBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-amber-500/15 font-medium text-xs text-amber-600 dark:text-amber-400 ${compact ? "px-2 py-0.5" : "px-2.5 py-1"} ${className ?? ""}`}
    >
      {label}
    </span>
  );
}
