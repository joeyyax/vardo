import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { cardVariants } from "@/components/ui/card";

/** Irreversible actions, at the bottom of a settings page. */
export function DangerZone({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="danger-zone-heading"
      className={cn(cardVariants({ variant: "plain" }), "surface-danger grid gap-4 border p-4 sm:p-6")}
    >
      <h2 id="danger-zone-heading" className="type-h3 text-destructive">
        Danger zone
      </h2>
      {children}
    </section>
  );
}

/** One irreversible action: what it does, and the control that starts it. */
export function DangerZoneRow({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
