import * as React from "react";
import { cn } from "@/lib/utils";

type DetailFieldProps = {
  label: string;
  children: React.ReactNode;
  className?: string;
};

function DetailField({ label, children, className }: DetailFieldProps) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-muted-foreground mb-1">
        {label}
      </dt>
      <dd className="text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}

export { DetailField };
export type { DetailFieldProps };
