"use client";

import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import type { ProjectStage } from "./project-dialog";
import { PROJECT_STAGE_LABELS } from "./project-dialog";

const STAGE_ORDER: ProjectStage[] = [
  "getting_started",
  "proposal",
  "agreement",
  "onboarding",
  "active",
  "ongoing",
  "offboarding",
  "completed",
];

type ProjectLifecycleTimelineProps = {
  currentStage: ProjectStage;
};

export function ProjectLifecycleTimeline({
  currentStage,
}: ProjectLifecycleTimelineProps) {
  const currentIndex = STAGE_ORDER.indexOf(currentStage);

  return (
    <div className="flex items-center gap-0 w-full overflow-x-auto py-1">
      {STAGE_ORDER.map((stage, index) => {
        const isPast = index < currentIndex;
        const isCurrent = index === currentIndex;
        const isFuture = index > currentIndex;

        return (
          <div key={stage} className="flex items-center flex-1 min-w-0">
            {/* Node */}
            <div className="flex flex-col items-center gap-1.5 min-w-0">
              <div
                className={cn(
                  "size-6 rounded-full flex items-center justify-center shrink-0 transition-colors",
                  isPast &&
                    "bg-primary text-primary-foreground",
                  isCurrent &&
                    "bg-primary text-primary-foreground ring-2 ring-primary/30 ring-offset-2 ring-offset-background",
                  isFuture &&
                    "bg-muted text-muted-foreground border border-border"
                )}
              >
                {isPast ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="text-[10px] font-medium">
                    {index + 1}
                  </span>
                )}
              </div>
              <span
                className={cn(
                  "text-[10px] leading-tight text-center truncate max-w-[80px]",
                  isCurrent && "font-semibold text-foreground",
                  isPast && "text-muted-foreground",
                  isFuture && "text-muted-foreground/60"
                )}
              >
                {PROJECT_STAGE_LABELS[stage]}
              </span>
            </div>

            {/* Connector line */}
            {index < STAGE_ORDER.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-px min-w-3 mx-1 mt-[-18px]",
                  index < currentIndex
                    ? "bg-primary"
                    : "bg-border"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
