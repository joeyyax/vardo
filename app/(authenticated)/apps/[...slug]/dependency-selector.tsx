"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { statusDotColor } from "@/lib/ui/status-colors";

export function DependencySelector({
  appId,
  appName,
  orgId,
  currentDeps,
  siblings,
}: {
  appId: string;
  appName: string;
  orgId: string;
  currentDeps: string[];
  siblings: { id: string; name: string; displayName: string; status: string; dependsOn: string[] | null }[];
}) {
  const router = useRouter();
  const [deps, setDeps] = useState<string[]>(currentDeps);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Transitive circular dependency prevention — walk the full graph
  function wouldCreateCycle(candidateDep: string): boolean {
    const visited = new Set<string>();
    const queue = [candidateDep];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === appName) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const app = siblings.find((a) => a.name === current);
      if (app?.dependsOn) queue.push(...app.dependsOn);
    }
    return false;
  }

  const wouldCircular = new Set(
    siblings
      .filter((s) => wouldCreateCycle(s.name))
      .map((s) => s.name)
  );

  // Available apps: siblings not already deps and not circular
  const available = siblings.filter(
    (s) => !deps.includes(s.name) && !wouldCircular.has(s.name)
  );

  async function saveDeps(updated: string[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dependsOn: updated.length > 0 ? updated : null }),
      });
      if (!res.ok) {
        toast.error("Failed to update dependencies");
        return;
      }
      setDeps(updated);
      toast.success("Dependencies updated");
      router.refresh();
    } catch {
      toast.error("Failed to update dependencies");
    } finally {
      setSaving(false);
    }
  }

  function handleAdd(name: string) {
    const updated = [...deps, name];
    saveDeps(updated);
    setAddOpen(false);
  }

  function handleRemove(name: string) {
    saveDeps(deps.filter((d) => d !== name));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">Deploy dependencies</p>
        {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {deps.map((depName) => {
          const sibling = siblings.find((s) => s.name === depName);
          return (
            <span
              key={depName}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
            >
              <span className={`size-1.5 rounded-full ${statusDotColor(sibling?.status ?? "stopped")}`} />
              {sibling?.displayName ?? depName}
              <button
                type="button"
                onClick={() => handleRemove(depName)}
                disabled={saving}
                className="ml-0.5 text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-50"
                aria-label={`Remove dependency on ${sibling?.displayName ?? depName}`}
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        {available.length > 0 && (
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center justify-center size-5 rounded-full border border-dashed border-muted-foreground/20 text-muted-foreground/40 hover:text-muted-foreground hover:border-muted-foreground/40 transition-colors"
                aria-label="Add dependency"
              >
                <Plus className="size-2.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-52 p-1.5">
              {available.map((s) => (
                <button
                  key={s.name}
                  onClick={() => handleAdd(s.name)}
                  disabled={saving}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <span className={`size-2 rounded-full shrink-0 ${statusDotColor(s.status)}`} />
                  <span className="flex-1 text-left truncate">{s.displayName}</span>
                </button>
              ))}
              {wouldCircular.size > 0 && (
                <div className="border-t mt-1 pt-1 px-2 py-1">
                  <p className="text-[10px] text-muted-foreground/60">
                    {[...wouldCircular].length === 1 ? "1 app excluded" : `${[...wouldCircular].length} apps excluded`} (circular dependency)
                  </p>
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}
        {deps.length === 0 && available.length === 0 && siblings.length === 0 && (
          <p className="text-xs text-muted-foreground/60">No sibling apps in this project</p>
        )}
        {deps.length === 0 && (available.length > 0 || siblings.length > 0) && (
          <p className="text-xs text-muted-foreground/60">None</p>
        )}
      </div>
    </div>
  );
}
