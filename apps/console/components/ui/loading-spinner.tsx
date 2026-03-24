import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type LoadingSpinnerProps = {
  className?: string;
  /** Icon size class. Defaults to "size-4" */
  size?: string;
  /** Center in a full-height container. Defaults to true */
  fullHeight?: boolean;
};

function LoadingSpinner({
  className,
  size = "size-4",
  fullHeight = true,
}: LoadingSpinnerProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center",
        fullHeight ? "h-full" : "py-8",
        className
      )}
    >
      <Loader2 className={cn(size, "animate-spin text-muted-foreground")} />
    </div>
  );
}

export { LoadingSpinner };
export type { LoadingSpinnerProps };
