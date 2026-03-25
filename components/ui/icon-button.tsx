import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "size" | "children"> & {
  icon: React.ComponentType<{ className?: string }>;
  tooltip: string;
  loading?: boolean;
  /** Button size class override. Defaults to "size-8" */
  iconSize?: string;
};

function IconButton({
  icon: Icon,
  tooltip,
  loading = false,
  iconSize,
  className,
  variant = "ghost",
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size="icon"
          type="button"
          className={cn(iconSize || "size-8", className)}
          disabled={loading || props.disabled}
          {...props}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Icon className="size-4" />
          )}
          <span className="sr-only">{tooltip}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export { IconButton };
export type { IconButtonProps };
