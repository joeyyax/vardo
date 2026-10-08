import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { cardVariants } from "@/components/ui/card";

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

/** "Nothing here yet" as an inset tray. */
export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        cardVariants({ variant: "inset" }),
        "flex flex-col items-center justify-center gap-4 p-12 text-center",
        className,
      )}
    >
      {Icon && <Icon className="size-8 text-muted-foreground/50" aria-hidden="true" />}
      <div className="space-y-1">
        <p className="type-h4">{title}</p>
        {body && <p className="type-body-sm text-muted-foreground max-w-md">{body}</p>}
      </div>
      {action}
    </div>
  );
}
