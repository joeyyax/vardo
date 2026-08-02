"use client";

import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Explains a label the product invented. Needs a TooltipProvider above it. */
export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What ${label} means`}
          className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
        >
          <Info className="size-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">{children}</TooltipContent>
    </Tooltip>
  );
}
