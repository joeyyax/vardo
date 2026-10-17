"use client";

import { Server, ServerCog } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { builtOn, type PlacementFields } from "@/lib/ui/build-placement";
import { cn } from "@/lib/utils";

/** A deploy's build target in a list row: the icon and target, with the label and transfer in a tooltip. */
export function BuiltOnMark({ deployment, className }: { deployment: PlacementFields; className?: string }) {
  const on = builtOn(deployment);
  if (!on) return null;
  const Icon = on.kind === "target" ? ServerCog : Server;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex shrink-0 items-center gap-1", className)} aria-label={on.label}>
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="max-sm:hidden">{on.kind === "target" ? on.target : "Built here"}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{on.label}</p>
        {on.detail && <p className="opacity-70">{on.detail}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

/** A deploy's build target in its detail view: the label, then how the image came back. */
export function BuiltOnFact({ deployment }: { deployment: PlacementFields }) {
  const on = builtOn(deployment);
  if (!on) return null;
  const Icon = on.kind === "target" ? ServerCog : Server;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {on.label}
      </span>
      {on.detail && <span className="text-muted-foreground">{on.detail}</span>}
    </span>
  );
}
