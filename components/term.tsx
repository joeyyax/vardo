"use client";

import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { GLOSSARY, glossaryHref, type GlossaryId } from "@/lib/ui/glossary";
import { cn } from "@/lib/utils";

const UNDERLINE = "underline decoration-dotted decoration-current/45 underline-offset-[3px]";

// --- Scope: one marked term per id in a dense list ---------------------------

type Claim = { who: string; passive: boolean };

class TermRegistry {
  private owners = new Map<GlossaryId, Claim[]>();
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** The first focusable instance, else the first passive one. */
  owner(id: GlossaryId): string | null {
    const list = this.owners.get(id) ?? [];
    return (list.find((c) => !c.passive) ?? list[0])?.who ?? null;
  }

  claim(id: GlossaryId, who: string, passive: boolean) {
    const list = this.owners.get(id) ?? [];
    if (!list.some((c) => c.who === who)) this.owners.set(id, [...list, { who, passive }]);
    this.emit();
  }

  release(id: GlossaryId, who: string) {
    const list = (this.owners.get(id) ?? []).filter((c) => c.who !== who);
    if (list.length) this.owners.set(id, list);
    else this.owners.delete(id);
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

const ScopeContext = createContext<TermRegistry | null>(null);

/** Inside a scope, each term is marked once: the first focusable instance, else the first passive one. */
export function TermScope({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new TermRegistry());
  return <ScopeContext.Provider value={registry}>{children}</ScopeContext.Provider>;
}

const noop = () => () => {};

/** Whether this instance is the first of its id in the nearest scope. True outside a scope and for free text. */
function useFirstInScope(id: GlossaryId | null, passive: boolean): boolean {
  const scope = useContext(ScopeContext);
  const scoped = id ? scope : null;
  const me = useId();
  useLayoutEffect(() => {
    if (!scoped || !id) return;
    scoped.claim(id, me, passive);
    return () => scoped.release(id, me);
  }, [scoped, id, me, passive]);
  const owner = useSyncExternalStore(
    scoped ? scoped.subscribe : noop,
    () => (scoped && id ? scoped.owner(id) : me),
    () => (scoped ? null : me),
  );
  return owner === me;
}

/** A glossary word, or free text that explains the words it marks. */
type TermSource = { id: GlossaryId; note?: undefined } | { note: string; id?: undefined };

// --- Term --------------------------------------------------------------------

/** A hidden explanation with a known id, for aria-describedby. */
export function TermNote({ id, note, noteId }: TermSource & { noteId: string }) {
  return (
    <span hidden id={noteId}>
      {note ?? GLOSSARY[id!].what}
    </span>
  );
}

/** A hidden explanation for a button or row whose label holds a passive term. */
export function useTermDescription(id: GlossaryId | null | undefined): {
  describedBy: string | undefined;
  description: ReactNode;
} {
  const descId = useId();
  if (!id) return { describedBy: undefined, description: null };
  return { describedBy: descId, description: <TermNote id={id} noteId={descId} /> };
}

function Explanation({ id, note, linkable }: TermSource & { linkable: boolean }) {
  if (note !== undefined) return <span className="text-left">{note}</span>;
  const entry = GLOSSARY[id];
  const href = glossaryHref(id);
  return (
    <span className="grid gap-1 text-left">
      {entry.label && <span className="font-semibold">{entry.label}</span>}
      <span>{entry.what}</span>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={linkable ? undefined : -1}
          onClick={(e) => e.stopPropagation()}
          className="w-fit font-medium underline underline-offset-2 hover:no-underline"
        >
          Learn more →
        </a>
      )}
    </span>
  );
}

/**
 * A product word, or words a `note` explains, with a plain-language explanation: a tooltip on hover or
 * focus, a popover on tap or Enter. `passive` drops the tab stop and popover for text inside a clickable row or button.
 */
export function Term({
  id,
  note,
  children,
  passive = false,
  className,
}: TermSource & {
  children: ReactNode;
  passive?: boolean;
  className?: string;
}) {
  const descId = useId();
  const popId = useId();
  const first = useFirstInScope(id ?? null, passive);
  const [tip, setTip] = useState(false);
  const [pinned, setPinned] = useState(false);
  const source = (id ? { id } : { note: note! }) as TermSource;
  const description = <TermNote {...source} noteId={descId} />;

  if (!first) return <span className={className}>{children}</span>;

  if (passive) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span data-term={id ?? "note"} aria-describedby={descId} className={cn(UNDERLINE, className)}>
              {children}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <Explanation {...source} linkable={false} />
          </TooltipContent>
        </Tooltip>
        {description}
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Popover open={pinned} onOpenChange={setPinned}>
        <Tooltip open={tip && !pinned} onOpenChange={setTip}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-term={id ?? "note"}
                aria-describedby={descId}
                // Keeps a surrounding row from also acting on the press.
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  UNDERLINE,
                  "inline cursor-help rounded-[3px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brass",
                  className,
                )}
              >
                {children}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <Explanation {...source} linkable={false} />
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          id={popId}
          aria-label={id ? GLOSSARY[id].term : typeof children === "string" ? children : undefined}
          className="w-72 text-[13px]"
          onClick={(e) => e.stopPropagation()}
        >
          <Explanation {...source} linkable />
        </PopoverContent>
      </Popover>
      {description}
    </TooltipProvider>
  );
}
