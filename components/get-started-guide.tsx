"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/messenger";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, Sparkles, PartyPopper } from "lucide-react";
import type { GuideStep, GuideStepCategory } from "@/lib/setup/guide";

type GuideData = {
  steps: GuideStep[];
  completed: string[];
  total: number;
  done: number;
};

const TOAST_ID = "get-started-guide";

const CATEGORY_LABELS: Record<GuideStepCategory, string> = {
  core: "Core",
  recommended: "Recommended",
  optional: "Optional",
};

const CATEGORY_ORDER: GuideStepCategory[] = ["core", "recommended", "optional"];

function GuideToast({ id }: { id: string | number }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<GuideData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/admin/guide")
      .then((res) => res.json())
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading || !data) return null;

  const allComplete = data.done >= data.total;

  // Group steps by category
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    steps: data.steps.filter((s) => s.category === cat),
  })).filter((g) => g.steps.length > 0);

  const progressPercent = data.total > 0 ? (data.done / data.total) * 100 : 0;

  if (allComplete) {
    return (
      <div className="w-[320px] bg-card border rounded-xl squircle p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PartyPopper className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-medium">All set!</span>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {data.done}/{data.total}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          You can disable this plugin in{" "}
          <button
            className="underline hover:text-foreground transition-colors"
            onClick={() => {
              toast.dismiss(id);
              router.push("/admin/plugins");
            }}
          >
            Admin &rarr; Plugins
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="w-[320px] bg-card border rounded-xl squircle shadow-lg overflow-hidden">
      {/* Header — always visible, click to toggle */}
      <button
        className="w-full flex items-center justify-between p-3 hover:bg-accent/50 transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium">Get Started</span>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {data.done}/{data.total}
        </span>
      </button>

      {/* Expanded checklist */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Progress bar */}
          <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Step groups */}
          {grouped.map((group) => (
            <div key={group.category}>
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.steps.map((step) => {
                  const done = data.completed.includes(step.id);
                  return (
                    <button
                      key={step.id}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm transition-colors",
                        done
                          ? "text-muted-foreground"
                          : "hover:bg-accent/50 text-foreground",
                      )}
                      onClick={() => {
                        if (!done) {
                          toast.dismiss(id);
                          router.push(step.href);
                        }
                      }}
                      disabled={done}
                    >
                      <div
                        className={cn(
                          "flex-shrink-0 h-4 w-4 rounded-full border flex items-center justify-center",
                          done
                            ? "bg-primary border-primary"
                            : "border-muted-foreground/30",
                        )}
                      >
                        {done && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                      </div>
                      <span className={cn("flex-1", done && "line-through")}>
                        {step.title}
                      </span>
                      {!done && (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Dismiss link */}
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-center pt-1"
            onClick={() => toast.dismiss(id)}
          >
            Dismiss guide
          </button>
        </div>
      )}
    </div>
  );
}

export function GetStartedGuide() {
  const shown = useRef(false);

  useEffect(() => {
    if (shown.current) return;
    shown.current = true;

    toast.custom((id) => <GuideToast id={id} />, {
      duration: Infinity,
      id: TOAST_ID,
    });
  }, []);

  return null;
}
