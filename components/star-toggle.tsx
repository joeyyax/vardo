"use client";

import { useCallback, useMemo, useState } from "react";
import { Star } from "lucide-react";
import { toast } from "@/lib/messenger";
import type { StarKind } from "@/lib/db/schema/enums";
import type { Starred } from "@/lib/ui/projects";
import { cn } from "@/lib/utils";

async function saveStar(orgId: string, kind: StarKind, targetId: string, on: boolean) {
  const base = `/api/v1/organizations/${orgId}/stars`;
  const res = on
    ? await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, targetId }),
      })
    : await fetch(`${base}?${new URLSearchParams({ kind, targetId })}`, { method: "DELETE" });
  if (!res.ok) throw new Error(String(res.status));
}

function failed(on: boolean, name: string) {
  toast.error(on ? `Couldn't star ${name}.` : `Couldn't unstar ${name}.`);
}

/** The user's stars in this org, toggled optimistically. */
export function useStars(orgId: string, initial: { projects: string[]; apps: string[] }) {
  const [projects, setProjects] = useState<ReadonlySet<string>>(() => new Set(initial.projects));
  const [apps, setApps] = useState<ReadonlySet<string>>(() => new Set(initial.apps));

  const toggle = useCallback(
    (kind: StarKind, id: string, name: string) => {
      const set = kind === "project" ? setProjects : setApps;
      const on = !(kind === "project" ? projects : apps).has(id);
      const apply = (value: boolean) =>
        set((s) => {
          const next = new Set(s);
          if (value) next.add(id);
          else next.delete(id);
          return next;
        });
      apply(on);
      saveStar(orgId, kind, id, on).catch(() => {
        apply(!on);
        failed(on, name);
      });
    },
    [orgId, projects, apps],
  );

  const starred: Starred = useMemo(() => ({ projects, apps }), [projects, apps]);
  return [starred, toggle] as const;
}

/** One project's or app's star, toggled optimistically. */
export function useStar(orgId: string, kind: StarKind, id: string, initial: boolean) {
  const [starred, setStarred] = useState(initial);
  const toggle = useCallback(
    (name: string) => {
      const on = !starred;
      setStarred(on);
      saveStar(orgId, kind, id, on).catch(() => {
        setStarred(!on);
        failed(on, name);
      });
    },
    [orgId, kind, id, starred],
  );
  return [starred, toggle] as const;
}

/** A detail header's star for one project or app. */
export function StarButton({ orgId, kind, id, name, initial }: { orgId: string; kind: StarKind; id: string; name: string; initial: boolean }) {
  const [starred, toggle] = useStar(orgId, kind, id, initial);
  return <StarToggle starred={starred} label={name} onToggle={() => toggle(name)} className="size-8 [&_svg]:size-4" />;
}

/** A star button. Filled when starred. */
export function StarToggle({
  starred,
  onToggle,
  label,
  tabIndex,
  className,
}: {
  starred: boolean;
  onToggle: () => void;
  /** What gets starred, for the accessible name. */
  label: string;
  tabIndex?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={starred}
      aria-label={`Star ${label}`}
      title={starred ? "Starred" : "Star"}
      tabIndex={tabIndex}
      data-star
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "squircle inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors",
        "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:text-brass",
        className,
      )}
    >
      <Star aria-hidden="true" className={cn("size-3.5", starred && "fill-current")} />
    </button>
  );
}
