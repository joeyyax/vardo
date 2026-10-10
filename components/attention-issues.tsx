"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EntityLink } from "@/components/entity-link";
import { FixButton, type RunAction } from "@/components/fix-action";
import { IssueGroup, IssueItem } from "@/components/issue-group";
import { toast } from "@/lib/messenger";
import type { AttentionFix, AttentionGroup, AttentionPost, GroupedItem } from "@/lib/ui/attention";
import { PROBLEM_GROUPS, type ProblemGroup } from "@/lib/ui/conditions";
import { attentionGroupTerm } from "@/lib/ui/glossary";

export type AttentionRunner = {
  busy: ReadonlySet<string>;
  run: (fix: Extract<AttentionFix, { run: RunAction }>, name: string) => void;
  open: (item: GroupedItem) => void;
};

/** The item's own detail, then what else was reported for the same subject. */
export function itemDetail(item: GroupedItem): string {
  const also = item.also.length ? `Also ${item.also.join(", ").toLowerCase()}` : "";
  return [item.detail, also].filter(Boolean).join(" · ");
}

function ItemFix({ fix, name, runner }: { fix: AttentionFix; name: string; runner: AttentionRunner }) {
  if ("href" in fix && fix.external) {
    return (
      <Button asChild size="xs">
        <a href={fix.href} target="_blank" rel="noopener noreferrer">
          {fix.label}
        </a>
      </Button>
    );
  }
  if ("href" in fix) {
    return (
      <Button asChild size="xs" variant="outline">
        <Link href={fix.href}>{fix.label}</Link>
      </Button>
    );
  }
  return (
    <FixButton
      fix={{ label: fix.label, run: fix.run }}
      busy={runner.busy.has(fix.app.name)}
      onRun={() => runner.run(fix, name)}
    />
  );
}

/** Sends the item's second request in place and says how it went. */
function ItemPost({ post }: { post: AttentionPost }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch(post.post, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (res.ok) toast.success(data.message ?? "Done");
      else toast.error(data.error ?? "Couldn't do that");
    } catch {
      toast.error("Couldn't do that");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void run()}>
      {busy && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {post.label}
    </Button>
  );
}

/** One problem group: what it means, then each subject with its cause, time since and fix. */
export function AttentionIssueGroup({ group, runner }: { group: AttentionGroup; runner: AttentionRunner }) {
  const meta = PROBLEM_GROUPS[group.key as ProblemGroup];
  const runs = group.items.flatMap((i) => (i.fix && "run" in i.fix ? [{ fix: i.fix, name: i.name }] : []));
  const bulk =
    meta?.bulk && runs.length > 1 ? (
      <Button type="button" size="xs" variant="outline" onClick={() => runs.forEach((r) => runner.run(r.fix, r.name))}>
        {meta.bulk} {runs.length === 2 ? "both" : `all ${runs.length}`}
      </Button>
    ) : undefined;

  return (
    <IssueGroup title={group.title} term={attentionGroupTerm(group.key)} count={group.items.length} why={group.why} bulk={bulk}>
      {group.items.map((item) => (
        <IssueItem
          key={item.subject}
          itemKey={item.subject}
          name={item.name}
          href={item.href}
          external={item.external}
          where={
            item.where && item.whereHref ? (
              <EntityLink href={item.whereHref} className="hover:text-foreground">
                {item.where}
              </EntityLink>
            ) : (
              item.where
            )
          }
          problem={{ tone: item.tone, title: item.title, detail: itemDetail(item), since: item.since ?? null }}
          showTitle={item.title !== group.title}
          onActivate={() => runner.open(item)}
          actions={
            item.fix || item.secondary ? (
              <>
                {item.fix && <ItemFix fix={item.fix} name={item.name} runner={runner} />}
                {item.secondary && <ItemPost post={item.secondary} />}
              </>
            ) : undefined
          }
        />
      ))}
    </IssueGroup>
  );
}
