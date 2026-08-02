import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon?: LucideIcon;
  /** One line, sentence case. Says what is missing, not "No data". */
  title: string;
  /** What to do about it, or why nothing is here yet. */
  body?: React.ReactNode;
  /** Button, dropdown or link. Rendered under the copy. */
  action?: React.ReactNode;
  className?: string;
};

/** The one dashed-border block for "nothing here yet" across the app. */
export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "squircle flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12 text-center",
        className,
      )}
    >
      {Icon && <Icon className="size-8 text-muted-foreground/50" aria-hidden="true" />}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {body && <p className="text-sm text-muted-foreground max-w-md">{body}</p>}
      </div>
      {action}
    </div>
  );
}
