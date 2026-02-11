"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ListTodo, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import type { DocumentContent } from "@/lib/template-engine/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Document = {
  id: string;
  type: "proposal" | "contract" | "change_order" | "orientation";
  status: "draft" | "sent" | "viewed" | "accepted" | "declined";
  title: string;
  content: DocumentContent;
};

type ScopeTaskPromptProps = {
  projectId: string;
  orgId: string;
  documents: Document[];
  onTasksCreated: () => void;
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractTaskCandidates(html: string): string[] {
  const matches = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/gi)];
  return matches
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter((t) => t.length > 3 && t.length < 200);
}

function getCandidatesFromDocuments(docs: Document[]): string[] {
  const accepted = docs.filter(
    (d) =>
      (d.type === "proposal" || d.type === "contract") &&
      d.status === "accepted"
  );

  const candidates: string[] = [];
  for (const doc of accepted) {
    if (!doc.content?.sections) continue;
    for (const section of doc.content.sections) {
      if (section.mode === "editable" && section.content) {
        candidates.push(...extractTaskCandidates(section.content));
      }
    }
  }

  // Deduplicate
  return [...new Set(candidates)];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScopeTaskPrompt({
  projectId,
  orgId,
  documents,
  onTasksCreated,
}: ScopeTaskPromptProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [isDismissed, setIsDismissed] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(`scope-tasks-dismissed-${projectId}`) === "true";
  });

  const rawCandidates = useMemo(
    () => getCandidatesFromDocuments(documents),
    [documents]
  );

  const [candidates, setCandidates] = useState<
    { name: string; selected: boolean }[]
  >(() => rawCandidates.map((name) => ({ name, selected: true })));

  // Don't render if no candidates or dismissed
  if (isDismissed || rawCandidates.length === 0) return null;

  function handleDismiss() {
    localStorage.setItem(`scope-tasks-dismissed-${projectId}`, "true");
    setIsDismissed(true);
  }

  function toggleCandidate(index: number) {
    setCandidates((prev) =>
      prev.map((c, i) =>
        i === index ? { ...c, selected: !c.selected } : c
      )
    );
  }

  function updateName(index: number, name: string) {
    setCandidates((prev) =>
      prev.map((c, i) => (i === index ? { ...c, name } : c))
    );
  }

  async function handleCreate() {
    const selected = candidates.filter((c) => c.selected && c.name.trim());
    if (selected.length === 0) {
      toast.error("Select at least one task");
      return;
    }

    setIsCreating(true);
    try {
      const results = await Promise.all(
        selected.map((c) =>
          fetch(`/api/v1/organizations/${orgId}/projects/${projectId}/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: c.name.trim() }),
          })
        )
      );

      const failures = results.filter((r) => !r.ok);
      if (failures.length > 0) {
        toast.error(`Created ${results.length - failures.length} tasks, ${failures.length} failed`);
      } else {
        toast.success(`Created ${selected.length} task${selected.length === 1 ? "" : "s"}`);
      }

      handleDismiss();
      onTasksCreated();
    } catch {
      toast.error("Failed to create tasks");
    } finally {
      setIsCreating(false);
    }
  }

  const selectedCount = candidates.filter((c) => c.selected).length;

  return (
    <Card className="squircle border-blue-200 dark:border-blue-800/50 bg-blue-50/50 dark:bg-blue-950/20">
      <CardContent className="py-5 px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
              <ListTodo className="size-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm">
                Import tasks from your scope
              </h3>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                We found items in your accepted documents that could be tasks.
                Select the ones you&apos;d like to create.
              </p>

              <div className="space-y-2">
                {candidates.map((candidate, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Checkbox
                      checked={candidate.selected}
                      onCheckedChange={() => toggleCandidate(i)}
                    />
                    <Input
                      value={candidate.name}
                      onChange={(e) => updateName(i, e.target.value)}
                      className="h-8 text-sm squircle"
                    />
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <Button
                  size="sm"
                  className="squircle"
                  onClick={handleCreate}
                  disabled={isCreating || selectedCount === 0}
                >
                  {isCreating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ListTodo className="size-4" />
                  )}
                  Create {selectedCount} Task{selectedCount !== 1 ? "s" : ""}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="squircle"
                  onClick={handleDismiss}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={handleDismiss}
          >
            <X className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
