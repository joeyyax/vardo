"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/lib/messenger";
import { cn } from "@/lib/utils";
import type { ProbeRecommendationStatus } from "@/lib/db/schema";
import { findTemplate } from "@/lib/probe-guard/templates";

export type SecurityRecommendation = {
  /** A stable id: a template id, or "wordpress-probes" for the rule suggestion. */
  id: string;
  kind: "template" | "wordpress";
  title: string;
  description: string;
  status: ProbeRecommendationStatus;
  updated?: boolean;
  /** Entries the template would add; empty for the wordpress suggestion. */
  entries?: { path: string; action: "allow" | "block" }[];
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recommendations: SecurityRecommendation[];
  /** Apply all pending; ignore closes the sheet and marks them ignored. */
  onApplyAll: () => Promise<void>;
  onIgnoreAll: () => Promise<void>;
  onApply: (id: string) => Promise<void>;
  onIgnore: (id: string) => Promise<void>;
  onUndo: (id: string) => Promise<void>;
};

/** Side sheet that lists every security recommendation with a one-line summary. */
export function SecurityRecommendationsSheet({ open, onOpenChange, recommendations, onApplyAll, onIgnoreAll, onApply, onIgnore, onUndo }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<null | "apply-all" | "ignore-all" | "row">(null);

  const pendingCount = recommendations.filter((r) => r.status === "pending").length;

  const run = useCallback(async (action: () => Promise<void>, key: "apply-all" | "ignore-all" | "row") => {
    setBusy(key);
    try {
      await action();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't apply changes");
    } finally {
      setBusy(null);
      if (key !== "row") setConfirming(false);
    }
  }, []);

  const handleApplyOne = (id: string) => run(() => onApply(id), "row");
  const handleIgnoreOne = (id: string) => run(() => onIgnore(id), "row");
  const handleUndo = (id: string) => run(() => onUndo(id), "row");

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl p-0">
          <SheetHeader className="px-6 pt-6 pb-4 border-b">
            <SheetTitle>Security recommendations</SheetTitle>
            <SheetDescription>
              From the latest scan. Nothing changes until you apply. Anything applied can be removed in Settings.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            {recommendations.length === 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">No recommendations yet.</p>
            )}
            {recommendations.map((rec) => (
              <article key={rec.id} className={cn("rounded-lg border p-4 space-y-3", rec.status !== "pending" && "opacity-60")}>
                <header className="flex items-start gap-2 justify-between">
                  <h3 className="text-sm font-medium leading-snug">{rec.title}</h3>
                  {rec.updated && rec.status === "pending" && (
                    <span className="shrink-0 rounded-md bg-status-warning-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-status-warning">Updated</span>
                  )}
                </header>
                <p className="text-xs text-muted-foreground leading-relaxed" dangerouslySetInnerHTML={{ __html: rec.description }} />
                {rec.entries && rec.entries.length > 0 && (
                  <dl className="grid gap-2 text-xs">
                    {(["allow", "block"] as const).map((action) => {
                      const list = rec.entries!.filter((e) => e.action === action);
                      if (list.length === 0) return null;
                      return (
                        <div key={action} className="grid gap-0.5">
                          <dt className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                            {action === "allow" ? "Lets through" : "Turns away"}
                          </dt>
                          {list.map((e) => (
                            <dd key={`${action}-${e.path}`} className="font-mono text-xs text-muted-foreground">{e.path}</dd>
                          ))}
                        </div>
                      );
                    })}
                  </dl>
                )}
                <footer className="flex items-center justify-between gap-2 pt-1">
                  {rec.status === "pending" ? (
                    <>
                      <span className="text-xs text-muted-foreground">
                        {rec.kind === "template"
                          ? `${(rec.entries ?? []).length} entries`
                          : "1 setting"}
                      </span>
                      <span className="flex items-center gap-2">
                        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void handleIgnoreOne(rec.id)}>
                          Ignore
                        </Button>
                        <Button size="xs" disabled={busy !== null} onClick={() => void handleApplyOne(rec.id)}>
                          {busy === "row" ? <Loader2 className="size-3.5 animate-spin" /> : "Apply"}
                        </Button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={cn(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        rec.status === "applied" ? "bg-status-success-muted text-status-success" : "bg-muted text-muted-foreground",
                      )}>
                        {rec.status === "applied" ? "Applied" : "Ignored"}
                      </span>
                      <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void handleUndo(rec.id)}>
                        {rec.status === "applied" ? "Undo" : "Restore"}
                      </Button>
                    </>
                  )}
                </footer>
              </article>
            ))}
            {recommendations.length > 0 && pendingCount === 0 && (
              <p className="text-center text-xs text-muted-foreground py-6">All reviewed.</p>
            )}
          </div>
          <SheetFooter className="px-6 py-4 border-t bg-muted/40">
            <Button variant="outline" disabled={busy !== null || pendingCount === 0} onClick={() => void run(() => onIgnoreAll(), "ignore-all")}>
              {busy === "ignore-all" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Ignore all
            </Button>
            <Button disabled={busy !== null || pendingCount === 0} onClick={() => setConfirming(true)}>
              {busy === "apply-all" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Apply all
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {confirming && (
        <ConfirmDialog
          pendingCount={pendingCount}
          templates={recommendations.filter((r) => r.status === "pending" && r.kind === "template")}
          otherCount={recommendations.filter((r) => r.status === "pending" && r.kind !== "template").length}
          busy={busy === "apply-all"}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await run(() => onApplyAll(), "apply-all");
            setConfirming(false);
          }}
        />
      )}
    </>
  );
}

function ConfirmDialog({
  pendingCount,
  templates,
  otherCount,
  busy,
  onCancel,
  onConfirm,
}: {
  pendingCount: number;
  templates: SecurityRecommendation[];
  otherCount: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const totalEntries = templates.reduce((sum, t) => sum + (t.entries?.length ?? 0), 0);
  const parts: string[] = [];
  if (templates.length > 0) parts.push(`${templates.length} ${templates.length === 1 ? "template" : "templates"} (${totalEntries} entries)`);
  if (otherCount > 0) parts.push(`${otherCount} other ${otherCount === 1 ? "recommendation" : "recommendations"}`);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="apply-recs-title">
      <div className="w-full max-w-md rounded-xl border bg-card p-5 shadow-lg space-y-3">
        <h3 id="apply-recs-title" className="text-sm font-medium">Apply {pendingCount} {pendingCount === 1 ? "recommendation" : "recommendations"}?</h3>
        <p className="text-xs text-muted-foreground">This adds {parts.join(" and ")}. You can remove any of it in Settings.</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Build the displayed recommendations list from the API response and the live settings. */
export function buildRecommendations(
  api: {
    recommendations: Array<{ templateId: string; name: string; description: string; status: ProbeRecommendationStatus; updated: boolean }>;
    suggestion: { id: "wordpress-probes"; ruleIds: string[]; title: string; description: string } | null;
  },
  appliedTemplateIds: readonly string[],
): SecurityRecommendation[] {
  const out: SecurityRecommendation[] = [];
  for (const rec of api.recommendations) {
    const template = findTemplate(rec.templateId);
    if (!template) continue;
    const entries: SecurityRecommendation["entries"] = [
      ...(template.letThrough ?? []).map((path) => ({ path, action: "allow" as const })),
      ...template.turnAway.map((entry) => ({ path: entry.value, action: "block" as const })),
    ];
    out.push({
      id: rec.templateId,
      kind: "template",
      title: rec.name,
      description: rec.description,
      status: rec.status,
      updated: rec.updated,
      entries,
    });
  }
  if (api.suggestion) {
    out.push({
      id: api.suggestion.id,
      kind: "wordpress",
      title: api.suggestion.title,
      description: api.suggestion.description,
      status: appliedTemplateIds.includes("wordpress") ? "applied" : "pending",
    });
  }
  return out;
}