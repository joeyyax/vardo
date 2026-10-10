"use client";

import { useEffect, useState, type ReactNode } from "react";
import { StatusMark } from "@/components/ui/status-dot";
import { EntityLink, entityLinkClass } from "@/components/entity-link";
import { Term, TermScope, useTermDescription } from "@/components/term";
import type { Problem } from "@/lib/ui/conditions";
import { termForText, type GlossaryId } from "@/lib/ui/glossary";
import { formatAbsoluteDateTime, formatSpan } from "@/lib/ui/relative-time";
import { cn } from "@/lib/utils";

/** "For 3d", client-only so server and client never disagree. Re-labelled every 30 seconds. */
export function Since({ since }: { since: string | null }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!since) return;
    const tick = () => setText(formatSpan(since));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [since]);
  if (!since || !text) return null;
  return (
    <time dateTime={since} title={formatAbsoluteDateTime(since)}>
      For {text}
    </time>
  );
}

/** One kind of problem: a count, what it means and a bulk fix where one fits. */
export function IssueGroup({
  title,
  term,
  count,
  why,
  bulk,
  children,
}: {
  title: string;
  /** Explains the title. */
  term?: GlossaryId | null;
  count: number;
  why: string;
  bulk?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{term ? <Term id={term}>{title}</Term> : title}</h3>
        <span className="rounded-full bg-accent px-[7px] text-[12.5px] leading-[19px] text-muted-foreground tabular-nums">
          {count}
        </span>
        {bulk && <span className="ml-auto">{bulk}</span>}
      </div>
      <p className="text-[13px] text-muted-foreground">{why}</p>
      <div className="mt-0.5 grid gap-0.5">
        <TermScope>{children}</TermScope>
      </div>
    </section>
  );
}

/**
 * One app or item with a problem: the cause, how long and the fix. The name links to its page and
 * the rest of the row activates it. Links, the activator and actions are siblings, never nested.
 */
export function IssueItem({
  itemKey,
  name,
  href,
  external = false,
  where,
  problem,
  showTitle,
  selected = false,
  actions,
  onActivate,
}: {
  /** Identifies the item to the panel's keyboard handling. */
  itemKey: string;
  name: string;
  /** The subject's page. */
  href?: string;
  /** Opens href in a new tab. */
  external?: boolean;
  /** Project, and parent when nested. Links allowed. */
  where?: ReactNode;
  problem: Pick<Problem, "tone" | "title" | "detail" | "since">;
  /** Off when the group heading already says it. */
  showTitle: boolean;
  selected?: boolean;
  actions?: ReactNode;
  onActivate: () => void;
}) {
  const term = showTitle ? termForText(problem.title) : null;
  const { describedBy, description } = useTermDescription(term);
  return (
    <div
      data-selected={selected}
      onClick={onActivate}
      className={cn(
        "grid cursor-pointer grid-cols-[12px_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 rounded-[10px] p-2.5",
        "hover:bg-row-hover has-[[data-panel-item]:focus-visible]:bg-row-hover has-[[data-panel-item]:focus-visible]:outline-2 has-[[data-panel-item]:focus-visible]:-outline-offset-2 has-[[data-panel-item]:focus-visible]:outline-brass",
        selected && "bg-brass-muted",
      )}
    >
      <span className="mt-1">
        <StatusMark tone={problem.tone === "error" ? "issue" : "warn"} />
      </span>
      <div className="grid min-w-0 gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          {href && external ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              data-entity-link
              onClick={(e) => e.stopPropagation()}
              className={cn(entityLinkClass, "font-semibold")}
            >
              {name}
            </a>
          ) : href ? (
            <EntityLink href={href} className="font-semibold">
              {name}
            </EntityLink>
          ) : (
            <span className="font-semibold">{name}</span>
          )}
          {where && <span className="text-muted-foreground/70">{where}</span>}
        </div>
        <button
          type="button"
          data-panel-item={itemKey}
          aria-label={`${name}: ${problem.title}`}
          aria-describedby={describedBy}
          onClick={(e) => {
            e.stopPropagation();
            onActivate();
          }}
          className="grid cursor-pointer gap-0.5 text-left outline-none"
        >
          <span className="text-[13.5px]">
            {showTitle && (
              <>
                <span className={problem.tone === "error" ? "text-status-error" : "text-status-warning"}>
                  {term ? (
                    <Term id={term} passive>
                      {problem.title}
                    </Term>
                  ) : (
                    problem.title
                  )}
                </span>
                {problem.detail && " · "}
              </>
            )}
            {problem.detail}
          </span>
          {problem.since && (
            <span className="text-[12.5px] text-muted-foreground/70">
              <Since since={problem.since} />
            </span>
          )}
          {description}
        </button>
      </div>
      {actions && (
        <div className="col-start-2 flex flex-wrap items-center gap-1 pt-1.5" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** Nothing in the list. Says so plainly. */
export function AllClear({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="grid justify-items-center gap-1.5 px-3 py-7 text-center">
      <svg viewBox="0 0 48 48" aria-hidden="true" className="mb-1.5 size-12">
        <circle cx="24" cy="24" r="22" className="fill-status-success-muted stroke-status-success-edge" strokeWidth="1" />
        <path d="M15 24.5 21 30.5 33 18" fill="none" className="stroke-status-success" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h3 className="type-h3">{title}</h3>
      {detail && <p className="max-w-[34ch] text-[13.5px] text-muted-foreground">{detail}</p>}
    </div>
  );
}
