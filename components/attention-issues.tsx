"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EntityLink } from "@/components/entity-link";
import { FixButton, type RunAction } from "@/components/fix-action";
import { IssueGroup, IssueItem } from "@/components/issue-group";
import type { AttentionFix, AttentionGroup, GroupedItem } from "@/lib/ui/attention";
import { PROBLEM_GROUPS, type ProblemGroup } from "@/lib/ui/conditions";

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
    <IssueGroup title={group.title} count={group.items.length} why={group.why} bulk={bulk}>
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
          actions={item.fix ? <ItemFix fix={item.fix} name={item.name} runner={runner} /> : undefined}
        />
      ))}
    </IssueGroup>
  );
}
