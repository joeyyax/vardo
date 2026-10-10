"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusMark } from "@/components/ui/status-dot";
import { PanelSection } from "@/components/detail-panel";
import { DeployProgress } from "@/components/deploy-progress";
import { CopyButton, DomainLink, EntityLink, entityLinkClass } from "@/components/entity-link";
import { appHref, deployHref, imageUrl, projectHref, siteUrl } from "@/lib/ui/hrefs";
import { FixButton, type FixTarget, type RunAction } from "@/components/fix-action";
import { AllClear, IssueGroup, IssueItem, Since } from "@/components/issue-group";
import { RelativeTime } from "@/components/relative-time";
import type { AppMetrics, MetricsHistory } from "@/components/app-metrics-card";
import { formatBytes, formatCores, formatMemLimit } from "@/lib/metrics/format";
import type { Problem } from "@/lib/ui/conditions";
import { typicalElapsedMs } from "@/lib/ui/deploy-timing";
import { SERVICE_KIND_LABEL } from "@/lib/ui/service-kind";
import { statusMarkTone } from "@/lib/ui/status-colors";
import {
  appsIn,
  issueGroups,

  markSubject,
  problemOf,
  walk,
  PANEL_TITLE,
  type Located,
  type PanelKey,
  type Section,
  type TreeNode,
} from "@/lib/ui/projects";
import { fixTarget, RowMenu, Sparkline, usageOf } from "./project-list";
import { Term } from "@/components/term";
import { termForText } from "@/lib/ui/glossary";

/** A problem title, explained when the glossary has it. */
function PanelTerm({ text }: { text: string }) {
  const id = termForText(text);
  return id ? <Term id={id}>{text}</Term> : text;
}

export type PanelContext = {
  orgId: string;
  sections: Section[];
  selected: string | null;
  busy: ReadonlySet<string>;
  run: (target: FixTarget, action: RunAction, fixing?: Problem) => void;
  jump: (name: string) => void;
  open: (name: string) => void;
  metrics: Map<string, AppMetrics>;
  history: Map<string, MetricsHistory>;
  cpuCount: number | null;
};

function FixActions({ loc, problem, ctx, primary = false }: { loc: Located; problem: Problem; ctx: PanelContext; primary?: boolean }) {
  const fix = problem.fix;
  const runs = fix && "run" in fix ? fix.run : null;
  return (
    <>
      {fix && (
        <FixButton
          fix={fix}
          size={primary ? "sm" : "xs"}
          variant={primary ? "default" : "outline"}
          busy={runs ? ctx.busy.has(fixTarget(loc.node, runs).name) : false}
          onRun={() => runs && ctx.run(fixTarget(loc.node, runs), runs, problem)}
        />
      )}
      <Button asChild size={primary ? "sm" : "xs"} variant="ghost">
        <Link href={problem.look.href}>{problem.look.label}</Link>
      </Button>
    </>
  );
}

/** "Project / Parent", each a link to its page. */
export function Where({ loc }: { loc: Located }) {
  const parent = loc.node.parent;
  return (
    <>
      <EntityLink href={projectHref(loc.project.name)} className="hover:text-foreground">
        {loc.project.displayName}
      </EntityLink>
      {parent && (
        <>
          {" / "}
          <EntityLink href={appHref(parent.name)} className="hover:text-foreground">
            {parent.displayName}
          </EntityLink>
        </>
      )}
    </>
  );
}

/** Jumps to an app's row in the list. The row around it does the same on click. */
function ShowInList({ name, label }: { name: string; label: string }) {
  return (
    <button
      type="button"
      data-panel-item={name}
      aria-label={label}
      className="ml-auto shrink-0 cursor-pointer rounded-sm text-[12.5px] text-muted-foreground/70 outline-none hover:text-foreground focus-visible:text-foreground"
    >
      Show in list
    </button>
  );
}

function DeployCard({ loc, ctx }: { loc: Located; ctx: PanelContext }) {
  const app = loc.node.app;
  const running = app.deployments.find((d) => d.status === "running" || d.status === "queued");
  return (
    <div
      onClick={() => ctx.jump(app.name)}
      className="squircle grid cursor-pointer gap-2.5 rounded-md bg-background-deep p-3.5 has-[[data-panel-item]:focus-visible]:outline-2 has-[[data-panel-item]:focus-visible]:outline-offset-1 has-[[data-panel-item]:focus-visible]:outline-brass"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="motion-safe:animate-pulse">
          <StatusMark tone="info" pending />
        </span>
        <EntityLink href={appHref(app.name)} className="font-semibold">
          {app.displayName}
        </EntityLink>
        <span className="text-muted-foreground/70">
          <Where loc={loc} />
        </span>
        {running?.gitSha && (
          <EntityLink href={deployHref(app.name, running.id)} className="font-mono text-xs text-muted-foreground/70 hover:text-foreground">
            {running.gitSha.slice(0, 7)}
          </EntityLink>
        )}
        <ShowInList name={app.name} label={`Show ${app.displayName} in the list`} />
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <DeployProgress
          orgId={ctx.orgId}
          appId={app.id}
          appName={app.name}
          deploymentId={running?.id}
          startedAt={running?.startedAt ?? new Date()}
          typicalMs={typicalElapsedMs(app.deployments)}
        />
      </div>
    </div>
  );
}

function DeployingBody({ ctx }: { ctx: PanelContext }) {
  const deploying = appsIn(ctx.sections, "deploying");
  if (deploying.length === 0) {
    const last = ctx.sections
      .flatMap((s) => s.nodes.map((n) => ({ app: n.app, d: n.app.deployments.find((d) => d.status === "success") })))
      .filter((x) => x.d)
      .sort((a, b) => new Date(b.d!.startedAt).getTime() - new Date(a.d!.startedAt).getTime())[0];
    return (
      <AllClear
        title="Nothing is deploying"
        detail={last ? `The last deploy was ${last.app.displayName}.` : undefined}
      />
    );
  }
  return (
    <div className="grid gap-2.5">
      {deploying.map((loc) => (
        <DeployCard key={loc.node.app.id} loc={loc} ctx={ctx} />
      ))}
    </div>
  );
}

function StateBody({ ctx, kind }: { ctx: PanelContext; kind: "running" | "stopped" }) {
  const list = appsIn(ctx.sections, kind);
  if (list.length === 0) {
    return kind === "running" ? (
      <AllClear title="Nothing is running" />
    ) : (
      <AllClear title="Nothing is stopped" detail="Every app is meant to be running." />
    );
  }
  const byProject = new Map<string, Located[]>();
  for (const loc of list) byProject.set(loc.project.id, [...(byProject.get(loc.project.id) ?? []), loc]);
  return (
    <>
      {[...byProject.values()].map((locs) => (
        <IssueGroupless
          key={locs[0].project.id}
          title={<EntityLink href={projectHref(locs[0].project.name)}>{locs[0].project.displayName}</EntityLink>}
          count={locs.length}
        >
          {locs.map((loc) => (
            <SlimItem key={loc.node.app.id} loc={loc} ctx={ctx} right={kind === "stopped" ? "stopped by you" : undefined} />
          ))}
        </IssueGroupless>
      ))}
    </>
  );
}

function IssueGroupless({ title, count, children }: { title: ReactNode; count: number; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-accent px-[7px] text-[12.5px] leading-[19px] text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="grid gap-0.5">{children}</div>
    </section>
  );
}

function SlimItem({ loc, ctx, right }: { loc: Located; ctx: PanelContext; right?: string }) {
  const app = loc.node.app;
  const mark = statusMarkTone(markSubject(loc.node));
  return (
    <div
      onClick={() => ctx.jump(app.name)}
      className="flex cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm hover:bg-row-hover has-[[data-panel-item]:focus-visible]:bg-row-hover has-[[data-panel-item]:focus-visible]:outline-2 has-[[data-panel-item]:focus-visible]:-outline-offset-2 has-[[data-panel-item]:focus-visible]:outline-brass"
    >
      <StatusMark tone={mark.tone} pending={mark.pending} />
      <EntityLink href={appHref(app.name)} className="shrink-0 font-semibold">
        {app.displayName}
      </EntityLink>
      {app.domains[0] && <DomainLink domain={app.domains[0]} className="min-w-0 text-muted-foreground/70 hover:text-foreground" />}
      <button
        type="button"
        data-panel-item={app.name}
        aria-label={`Show ${app.displayName} in the list`}
        className="ml-auto min-w-0 flex-1 cursor-pointer text-right text-[12.5px] text-muted-foreground/70 outline-none"
      >
        {right ?? (app.containerStartedAt ? <Since since={new Date(app.containerStartedAt).toISOString()} /> : null)}
      </button>
    </div>
  );
}

/** Every open problem in the listed apps, by kind. For a page scoped to one project. */
function IssuesBody({ ctx }: { ctx: PanelContext }) {
  const groups = issueGroups(ctx.sections);
  if (groups.length === 0) return <AllClear title="Nothing needs attention" detail="Every app is running as expected." />;
  return (
    <>
      {groups.map((g) => (
        <IssueGroup key={g.key} title={g.meta.title} count={g.items.length} why={g.meta.why}>
          {g.items.map((item) => (
            <IssueItem
              key={item.node.app.id}
              itemKey={item.node.app.name}
              name={item.node.app.displayName}
              href={appHref(item.node.app.name)}
              problem={item.problem}
              showTitle
              selected={ctx.selected === item.node.app.name}
              actions={<FixActions loc={item} problem={item.problem} ctx={ctx} />}
              onActivate={() => ctx.jump(item.node.app.name)}
            />
          ))}
        </IssueGroup>
      ))}
    </>
  );
}

/** The list a page stat opens. */
export function PanelList({ panel, ctx }: { panel: PanelKey; ctx: PanelContext }) {
  switch (panel) {
    case "deploying":
      return <DeployingBody ctx={ctx} />;
    case "running":
    case "stopped":
      return <StateBody ctx={ctx} kind={panel} />;
    case "attention":
      return <IssuesBody ctx={ctx} />;
  }
}

function relatedOf(loc: Located, sections: Section[]): { label: string; node: TreeNode; note: string }[] {
  const { node } = loc;
  const out: { label: string; node: TreeNode; note: string }[] = [];
  const all = sections.flatMap((s) => walk(s.nodes));
  const find = (name: string) => all.find((n) => n.app.name === name);
  if (node.parent) {
    const parent = find(node.parent.name);
    if (parent) out.push({ label: node.relation === "service" ? "Part of" : "Used by", node: parent, note: node.relation === "service" ? "compose app" : "separate app" });
  }
  for (const child of node.children) {
    out.push({ label: child.relation === "service" ? "Service" : "Uses", node: child, note: child.relation === "dependency" ? "separate app" : "" });
  }
  const shown = new Set(out.map((r) => r.node.app.name));
  for (const dep of node.app.dependsOn ?? []) {
    const n = find(dep);
    if (n && !shown.has(dep)) {
      out.push({ label: node.relation === "service" ? "Needs" : "Uses", node: n, note: "" });
      shown.add(dep);
    }
  }
  for (const n of all) {
    if (!shown.has(n.app.name) && (n.app.dependsOn ?? []).includes(node.app.name)) {
      out.push({ label: "Used by", node: n, note: "" });
      shown.add(n.app.name);
    }
  }
  return out;
}

function deployMark(status: string) {
  return status === "failed" ? <StatusMark tone="issue" /> : status === "running" || status === "queued" ? <StatusMark tone="info" pending /> : <StatusMark tone="good" />;
}

/** One app: a status sentence, one primary action, two numbers, then Related and Deploys. */
export function AppDetail({ loc, ctx }: { loc: Located; ctx: PanelContext }) {
  const { node } = loc;
  const app = node.app;
  const p = problemOf(node) ?? walk(node.children).map(problemOf).find(Boolean) ?? null;
  const mark = statusMarkTone(markSubject(node));
  const stopped = app.parked || app.status === "stopped";
  const usage = app.status === "active" || app.status === "deploying" ? usageOf(node, ctx.metrics, ctx.history) : null;
  const related = relatedOf(loc, ctx.sections);
  const running = app.deployments.find((d) => d.status === "running" || d.status === "queued");
  const primaryAction: RunAction = stopped || node.relation === "service" ? "restart" : "deploy";
  const primaryLabel = stopped ? "Start" : node.relation === "service" ? "Restart" : "Deploy";

  return (
    <>
      <div className="flex items-baseline gap-2 text-sm">
        <span className="translate-y-px">
          <StatusMark tone={mark.tone} pending={mark.pending} />
        </span>
        <span className="grid gap-0.5">
          {p ? (
            <>
              <span className={p.tone === "error" ? "text-status-error" : "text-status-warning"}>
                <PanelTerm text={p.title} />
              </span>
              {(p.detail || p.since) && (
                <span className="text-muted-foreground">
                  {p.detail}
                  {p.detail && p.since && " · "}
                  {p.since && <Since since={p.since} />}
                </span>
              )}
            </>
          ) : stopped ? (
            <span className="text-muted-foreground">
              <Term id="parked">Stopped by you</Term>. Vardo leaves it down until you start it.
            </span>
          ) : app.status === "deploying" ? (
            <span className="text-status-info">
              <Term id="deploying">Deploying</Term>
            </span>
          ) : (
            <span className="text-muted-foreground">
              <Term id="running">Running</Term>{app.containerStartedAt && <> · <Since since={new Date(app.containerStartedAt).toISOString()} /></>}
            </span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {p ? (
          <FixActions loc={loc} problem={p} ctx={ctx} primary />
        ) : app.status === "deploying" ? (
          <Button asChild size="sm">
            <Link href={running ? deployHref(app.name, running.id) : appHref(app.name, "deployments")}>View deploy</Link>
          </Button>
        ) : (
          <FixButton
            fix={{ label: primaryLabel, run: primaryAction }}
            size="sm"
            variant="default"
            busy={ctx.busy.has(fixTarget(node, primaryAction).name)}
            onRun={() => ctx.run(fixTarget(node, primaryAction), primaryAction)}
          />
        )}
        {p?.look.label !== "View logs" && (
          <Button asChild size="sm" variant="ghost">
            <Link href={appHref(app.name, "logs")}>Logs</Link>
          </Button>
        )}
        <RowMenu node={node} ctx={ctx} />
      </div>

      {running && (
        <DeployProgress
          orgId={ctx.orgId}
          appId={app.id}
          appName={app.name}
          startedAt={running.startedAt}
          typicalMs={typicalElapsedMs(app.deployments)}
        />
      )}

      {usage && (
        <div className="grid gap-2.5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[22px] leading-[1.1] font-semibold tabular-nums">{formatCores(usage.cpu)}</div>
              <div className="text-[12.5px] text-muted-foreground">CPU{ctx.cpuCount ? ` of ${ctx.cpuCount} host cores` : ""}</div>
            </div>
            <div>
              <div className="text-[22px] leading-[1.1] font-semibold tabular-nums">
                {formatBytes(usage.memory)}
                {usage.memoryLimit > 0 && (
                  <small className="text-[13px] font-normal text-muted-foreground"> of {formatMemLimit(usage.memoryLimit)}</small>
                )}
              </div>
              <div className="text-[12.5px] text-muted-foreground">memory</div>
            </div>
          </div>
          {usage.series.length > 1 && (
            <div className="grid gap-1">
              <Sparkline data={usage.series} w={376} h={48} className="h-12 w-full text-[var(--chart-cpu)]" />
              <span className="text-xs text-muted-foreground">CPU, last hour</span>
            </div>
          )}
        </div>
      )}

      <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted-foreground">Image</dt>
        <dd className="font-mono text-xs [overflow-wrap:anywhere]">
          {app.imageName ? (
            (() => {
              const url = imageUrl(app.imageName);
              return url ? (
                <a href={url} target="_blank" rel="noreferrer" title="Open the registry page" className={entityLinkClass}>
                  {app.imageName}
                </a>
              ) : (
                app.imageName
              );
            })()
          ) : app.services.length ? (
            <EntityLink href={appHref(app.name, "services")}>compose · {app.services.length} services</EntityLink>
          ) : app.gitUrl ? (
            <EntityLink href={appHref(app.name, "build")}>built from source</EntityLink>
          ) : (
            "—"
          )}
        </dd>
        {app.domains[0] && (
          <>
            <dt className="text-muted-foreground">Domain</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <DomainLink domain={app.domains[0]} />
              <CopyButton value={siteUrl(app.domains[0])} label={`Copy ${app.domains[0]}`} />
              {app.domains.length > 1 && (
                <EntityLink href={appHref(app.name, "networking")} className="text-muted-foreground hover:text-foreground">
                  +{app.domains.length - 1}
                </EntityLink>
              )}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Deployed</dt>
        <dd>
          {app.deployments[0] ? (
            <EntityLink href={deployHref(app.name, app.deployments[0].id)} className="inline-flex items-baseline gap-1.5">
              {app.deployments[0].gitSha && <span className="font-mono text-xs">{app.deployments[0].gitSha.slice(0, 7)}</span>}
              <RelativeTime date={app.deployments[0].startedAt} className="text-muted-foreground" />
            </EntityLink>
          ) : node.relation === "service" && node.parent ? (
            <>
              with <EntityLink href={appHref(node.parent.name, "deployments")}>{node.parent.displayName}</EntityLink>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-muted-foreground">Backups</dt>
        <dd>
          <EntityLink href={appHref(app.name, "backups")} className={app.lastBackupAt ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/70 hover:text-foreground"}>
            {app.lastBackupAt ? (
              <>
                last good <RelativeTime date={app.lastBackupAt} />
              </>
            ) : (
              "none on record"
            )}
          </EntityLink>
        </dd>
        <dt className="text-muted-foreground">
          <Term id="service-kind">Kind</Term>
        </dt>
        <dd>{SERVICE_KIND_LABEL[app.kind]}</dd>
        {app.priority === "critical" && (
          <>
            <dt className="text-muted-foreground">Priority</dt>
            <dd>Critical</dd>
          </>
        )}
      </dl>

      {related.length > 0 && (
        <PanelSection title="Related">
          <div className="grid gap-0.5">
            {related.map((r) => {
              const m = statusMarkTone(markSubject(r.node));
              return (
                <div
                  key={`${r.label}-${r.node.app.id}`}
                  onClick={() => ctx.jump(r.node.app.name)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-accent has-[[data-panel-item]:focus-visible]:bg-accent"
                >
                  <span className="w-16 shrink-0 text-[12.5px] text-muted-foreground/70">{r.label}</span>
                  <StatusMark tone={m.tone} pending={m.pending} />
                  <EntityLink href={appHref(r.node.app.name)}>{r.node.app.displayName}</EntityLink>
                  <button
                    type="button"
                    data-panel-item={r.node.app.name}
                    aria-label={`Show ${r.node.app.displayName} here`}
                    className="ml-auto min-w-0 flex-1 cursor-pointer text-right text-[12.5px] text-muted-foreground/70 outline-none"
                  >
                    {r.note}
                  </button>
                </div>
              );
            })}
          </div>
        </PanelSection>
      )}

      {app.deployments.length > 0 && (
        <PanelSection title="Deploys">
          <div className="grid text-[13px]">
            {app.deployments.map((d, i) => (
              <Link
                key={d.id}
                href={deployHref(app.name, d.id)}
                className="-mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1 outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-brass"
              >
                {deployMark(d.status)}
                <span className="font-mono text-xs">{d.gitSha ? d.gitSha.slice(0, 7) : d.trigger ?? "deploy"}</span>
                <RelativeTime date={d.startedAt} className="text-muted-foreground" />
                <span
                  className={
                    d.status === "failed"
                      ? "ml-auto text-status-error"
                      : d.status === "running" || d.status === "queued"
                        ? "ml-auto text-status-info"
                        : "ml-auto text-muted-foreground/70"
                  }
                >
                  {d.status === "success" ? (i === 0 ? "live" : "") : d.status.replace("_", " ")}
                </span>
              </Link>
            ))}
          </div>
        </PanelSection>
      )}
    </>
  );
}

/** The drawer header's way out to the full page. */
export function OpenAppLink({ name }: { name: string }) {
  return (
    <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
      <Link href={appHref(name)}>Open app →</Link>
    </Button>
  );
}

/** "← Needs attention", back from an app to the list it was opened from. */
export function BackLink({ panel, onBack }: { panel: PanelKey; onBack: () => void }) {
  return (
    <button
      type="button"
      data-back
      onClick={onBack}
      className="mb-1.5 flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      {PANEL_TITLE[panel]}
    </button>
  );
}
