"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";
import { cn } from "@/lib/utils";
import {
  appProbeGuardSchema,
  type AppProbeGuard,
} from "@/lib/probe-guard/settings";
import type { CustomBlock } from "@/lib/probe-guard/blocks";
import {
  BLOCK_KINDS,
  blockProblem,
} from "@/lib/probe-guard/blocks";
import {
  PROBE_RULES,
  exceptionProblem,
  type ProbeRule,
  type RuleOverrides,
} from "@/lib/probe-guard/rules";
import { PROBE_TEMPLATES, type ProbeTemplate } from "@/lib/probe-guard/templates";
import type { ProbeRecommendationStatus } from "@/lib/db/schema";
import type { SecurityHeaderConfig } from "@/lib/security/response-headers";
import { SecurityHeadersFields } from "./security-headers-fields";
import {
  SecurityRecommendationsSheet,
  buildRecommendations,
  type SecurityRecommendation,
} from "./security-recommendations-sheet";

type RecommendationRow = {
  templateId: string;
  name: string;
  description: string;
  status: ProbeRecommendationStatus;
  updated: boolean;
};

type GuardData = {
  settings: AppProbeGuard;
  suggestion: { id: "wordpress-probes"; ruleIds: string[]; title: string; description: string } | null;
  recommendations: RecommendationRow[];
  available: boolean;
  traps: string[];
  canBanPermanently: boolean;
  /** Stats are available from guardOverview but the settings card doesn't need them. */
  stats?: unknown;
  bans?: unknown;
};

const CATEGORY_LABEL: Record<string, string> = {
  secrets: "Secrets",
  vcs: "Version control",
  wordpress: "WordPress",
  "db-admin": "Database admin",
  cgi: "CGI",
  framework: "Frameworks",
  "server-info": "Server info",
  backup: "Backups",
  traversal: "Path traversal",
  router: "Routers",
};

const ORDER = ["secrets", "vcs", "wordpress", "db-admin", "cgi", "framework", "server-info", "backup", "traversal", "router"];

type Props = {
  orgId: string;
  appId: string;
  initialSecurityHeaders: SecurityHeaderConfig;
  securityHeadersLive: boolean;
  /** Called after the security headers save so the page can update. */
  onSavedHeaders?: (config: SecurityHeaderConfig) => void;
};

async function requestGuard(url: string): Promise<GuardData | null> {
  const res = await fetch(url).catch(() => null);
  return res?.ok ? ((await res.json()) as GuardData) : null;
}

/** Three cards, each with its own Save: probe guard (on/off + robots), probe rules (templates + entries + Block common probes), response headers. */
export function SecuritySettings({ orgId, appId, initialSecurityHeaders, securityHeadersLive, onSavedHeaders }: Props) {
  const url = `/api/v1/organizations/${orgId}/apps/${appId}/probe-guard`;
  const headersUrl = `/api/v1/organizations/${orgId}/apps/${appId}`;
  const recUrl = `${url}/recommendations`;
  const [data, setData] = useState<GuardData | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationRow[]>([]);
  const [suggestion, setSuggestion] = useState<GuardData["suggestion"]>(null);
  const [rulesDraft, setRulesDraft] = useState<AppProbeGuard | null>(null);
  const [rulesExceptionText, setRulesExceptionText] = useState("");
  const [entryKind, setEntryKind] = useState<(typeof BLOCK_KINDS)[number]>("prefix");
  const [entryPath, setEntryPath] = useState("");
  const [entryNote, setEntryNote] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [savingRules, setSavingRules] = useState(false);
  const [savingGuard, setSavingGuard] = useState(false);
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [robotsTxt, setRobotsTxt] = useState(false);
  const [savedGuardNote, setSavedGuardNote] = useState(false);
  const [headers, setHeaders] = useState<SecurityHeaderConfig>(initialSecurityHeaders);
  const [savingHeaders, setSavingHeaders] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const apply = useCallback((next: GuardData | null) => {
    if (!next) return;
    setData(next);
    setRecommendations(next.recommendations);
    setSuggestion(next.suggestion);
    setRulesDraft(next.settings);
    setRulesExceptionText(next.settings.exceptions.join("\n"));
    setGuardEnabled(next.settings.enabled);
    setRobotsTxt(next.settings.robotsTxt);
  }, []);

  const load = useCallback(async () => apply(await requestGuard(url)), [url, apply]);

  useEffect(() => {
    let cancelled = false;
    requestGuard(url).then((next) => {
      if (!cancelled) apply(next);
    });
    return () => {
      cancelled = true;
    };
  }, [url, apply]);

  const recommendationsList: SecurityRecommendation[] = useMemo(() => {
    if (!data) return [];
    return buildRecommendations(
      { recommendations: recommendations.map((r) => ({ ...r, status: r.status })), suggestion },
      rulesDraft?.templates ?? data.settings.templates,
    );
  }, [data, recommendations, suggestion, rulesDraft]);

  const pendingCount = recommendationsList.filter((r) => r.status === "pending").length;

  if (!data || !rulesDraft) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading probe guard...
      </div>
    );
  }

  const next: AppProbeGuard = (() => {
    const exceptions = rulesExceptionText.split("\n").map((l) => l.trim()).filter(Boolean);
    const dedup: CustomBlock[] = [];
    for (const b of rulesDraft.blocks) {
      if (!dedup.some((d) => d.kind === b.kind && d.value === b.value)) dedup.push(b);
    }
    return { ...rulesDraft, exceptions, blocks: dedup };
  })();
  const rulesDirty = JSON.stringify(next) !== JSON.stringify(data.settings);

  /** Renders with `validated` going through the schema once before saving. */
  async function saveRules() {
    const validated = appProbeGuardSchema.safeParse(next);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      toast.error(issue?.message ?? "Couldn't save");
      return;
    }
    setSavingRules(true);
    try {
      const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validated.data) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? "Couldn't save");
        return;
      }
      toast.success(body?.applied === "live" ? "Probe rules saved and applied" : "Probe rules saved");
      await load();
    } finally {
      setSavingRules(false);
    }
  }

  /** Save the on/off + robots.txt card. */
  async function saveGuard() {
    if (!rulesDraft) return;
    setSavingGuard(true);
    try {
      const nextSettings: AppProbeGuard = {
        enabled: guardEnabled,
        robotsTxt,
        exceptions: rulesDraft.exceptions,
        rules: rulesDraft.rules,
        blocks: rulesDraft.blocks,
        templates: rulesDraft.templates,
      };
      const validated = appProbeGuardSchema.safeParse(nextSettings);
      if (!validated.success) {
        toast.error("Couldn't save");
        return;
      }
      const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validated.data) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? "Couldn't save");
        return;
      }
      toast.success(body?.applied === "live" ? "Probe guard saved and applied" : "Probe guard saved");
      setSavedGuardNote(true);
      await load();
    } finally {
      setSavingGuard(false);
    }
  }

  const guardDirty = guardEnabled !== data.settings.enabled || robotsTxt !== data.settings.robotsTxt;

  function addEntry() {
    if (!rulesDraft) return;
    setEntryError(null);
    const trimmed = entryPath.trim();
    if (!trimmed) {
      setEntryError("Enter a path or pattern");
      return;
    }
    if (entryKind !== "regex") {
      const problem = exceptionProblem(trimmed);
      if (problem) {
        setEntryError(problem);
        return;
      }
    }
    const entry: CustomBlock = {
      kind: entryKind,
      value: trimmed,
      note: entryNote.trim() || undefined,
    };
    const problem = blockProblem(entry);
    if (problem) {
      setEntryError(problem);
      return;
    }
    if (rulesDraft.blocks.some((b) => b.kind === entry.kind && b.value === entry.value)) {
      setEntryError("That entry is already added");
      return;
    }
    setRulesDraft({
      enabled: rulesDraft.enabled,
      robotsTxt: rulesDraft.robotsTxt,
      exceptions: rulesDraft.exceptions,
      rules: rulesDraft.rules,
      templates: rulesDraft.templates,
      blocks: [...rulesDraft.blocks, entry],
    });
    setEntryPath("");
    setEntryNote("");
  }

  function removeEntry(index: number) {
    if (!rulesDraft) return;
    const block = rulesDraft.blocks[index];
    if (block.template) {
      toast.error("Remove the template that added this entry instead");
      return;
    }
    setRulesDraft({
      ...rulesDraft,
      blocks: rulesDraft.blocks.filter((_, i) => i !== index),
    });
  }

  function toggleTemplate(templateId: string, on: boolean) {
    if (!rulesDraft) return;
    if (on) {
      setRulesDraft({ ...rulesDraft, templates: [...new Set([...rulesDraft.templates, templateId])] });
    } else {
      setRulesDraft({
        ...rulesDraft,
        templates: rulesDraft.templates.filter((t) => t !== templateId),
      });
    }
  }

  function toggleRule(ruleId: string, on: boolean) {
    if (!rulesDraft) return;
    const rules: RuleOverrides = { ...rulesDraft.rules };
    if (on) delete rules[ruleId];
    else rules[ruleId] = false;
    setRulesDraft({ ...rulesDraft, rules });
  }

  async function saveHeaders() {
    setSavingHeaders(true);
    try {
      const res = await fetch(headersUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ securityHeaders: headers }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? "Couldn't save");
        return;
      }
      toast.success(securityHeadersLive ? "Headers saved" : "Headers saved — redeploy to apply");
      onSavedHeaders?.(headers);
    } finally {
      setSavingHeaders(false);
    }
  }

  async function postRecommendations(body: Parameters<typeof postRecsBody>[0]) {
    const res = await fetch(recUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(out?.error ?? "Couldn't save");
      throw new Error(out?.error ?? "save failed");
    }
    return out;
  }

  function postRecsBody(opts: {
    action: "apply" | "ignore" | "restore";
    templateIds: string[];
    suggestionId?: "wordpress-probes";
    suggestionBlock?: boolean;
  }) {
    return opts;
  }

  async function handleApplyAll() {
    const pending = recommendationsList.filter((r) => r.status === "pending");
    const templateIds = pending.filter((r) => r.kind === "template").map((r) => r.id);
    const wordpress = pending.find((r) => r.kind === "wordpress");
    const body = postRecsBody({
      action: "apply",
      templateIds,
      ...(wordpress ? { suggestionId: "wordpress-probes", suggestionBlock: true } : undefined),
    });
    await postRecommendations(body);
    await load();
    toast.success("Recommendations applied");
  }

  async function handleIgnoreAll() {
    const pending = recommendationsList.filter((r) => r.status === "pending");
    const templateIds = pending.filter((r) => r.kind === "template").map((r) => r.id);
    if (templateIds.length === 0) return;
    await postRecommendations({ action: "ignore", templateIds });
    await load();
    toast.success("Ignored");
  }

  async function handleApply(id: string) {
    if (id === "wordpress-probes") {
      await postRecommendations({ action: "apply", templateIds: [], suggestionId: "wordpress-probes", suggestionBlock: true });
    } else {
      await postRecommendations({ action: "apply", templateIds: [id] });
    }
    await load();
    toast.success("Applied");
  }

  async function handleIgnore(id: string) {
    await postRecommendations({ action: "ignore", templateIds: [id] });
    await load();
  }

  async function handleUndo(id: string) {
    if (id === "wordpress-probes") {
      // Undo means re-asking; the API doesn't expose this. Refuse cleanly.
      toast.error("Restore the WordPress question by removing the matching rule overrides");
      return;
    }
    const current = recommendationsList.find((r) => r.id === id);
    if (!current) return;
    if (current.status === "ignored") {
      await postRecommendations({ action: "restore", templateIds: [id] });
    } else {
      // applied -> remove the template
      toggleTemplate(id, false);
      await postRecommendations({ action: "apply", templateIds: [id] });
    }
    await load();
    toast.success("Updated");
  }

  const filteredRules = filter
    ? PROBE_RULES.filter((r) =>
        [r.label, r.id, r.category, r.pattern].join(" ").toLowerCase().includes(filter.toLowerCase()),
      )
    : PROBE_RULES;

  const headersDirty = JSON.stringify(headers) !== JSON.stringify(initialSecurityHeaders);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Ban thresholds and trap paths come from the instance: 5 probes in 10 minutes, then a 1 hour ban.{" "}
        <Link href="/admin/probe-guard" className="text-primary underline-offset-2 hover:underline">Instance rules</Link>.
      </p>

      {pendingCount > 0 && (
        <Banner count={pendingCount} onReview={() => setSheetOpen(true)} onApplyAll={() => void handleApplyAll().then(() => setSheetOpen(false))} onIgnoreAll={() => void handleIgnoreAll().then(() => setSheetOpen(false))} />
      )}

      {/* Probe guard card: on/off + robots.txt */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Probe guard</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Turns away requests for /.env, /.git/ and similar at the proxy, before they reach the app.
            </p>
          </div>
          <Switch checked={guardEnabled} onCheckedChange={setGuardEnabled} aria-label="Probe guard" />
        </CardHeader>
        {guardEnabled && (
          <CardContent className="space-y-4 border-t pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="max-w-prose space-y-1">
                <Label htmlFor="probe-guard-robots">Serve robots.txt with trap lines</Label>
                <p className="text-xs text-muted-foreground">
                  For apps without their own. Anything that fetches a listed trap path is banned.
                </p>
              </div>
              <Switch id="probe-guard-robots" checked={robotsTxt} onCheckedChange={setRobotsTxt} />
            </div>
            {!data.available && (
              <p className="text-xs text-status-warning">Set ENCRYPTION_MASTER_KEY to turn the guard on for this instance.</p>
            )}
          </CardContent>
        )}
        <div className="flex items-center justify-end gap-3 border-t bg-muted/30 px-4 py-3 rounded-b-xl">
          <span className="text-xs text-muted-foreground">{savedGuardNote ? "Saved" : guardDirty ? "Unsaved changes" : "Saved"}</span>
          <Button size="sm" onClick={() => void saveGuard()} disabled={savingGuard || !guardDirty}>
            {savingGuard ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </Card>

      {/* Probe rules card: templates + entries + Block common probes fold */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Probe rules</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Templates adjust the always-on rules for a stack. Entries are paths you let through or turn away.
          </p>
        </CardHeader>
        <CardContent className="space-y-5 border-t pt-5">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Templates</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {PROBE_TEMPLATES.map((t) => {
                const on = rulesDraft.templates.includes(t.id);
                return (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    on={on}
                    onToggle={(value) => toggleTemplate(t.id, value)}
                  />
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Entries <span className="ml-2 text-muted-foreground/70">· {rulesDraft.blocks.length + rulesDraft.exceptions.length}</span>
              </Label>
            </div>
            <EntriesTable
              blocks={rulesDraft.blocks}
              exceptions={rulesExceptionText.split("\n").map((l) => l.trim()).filter(Boolean)}
              templates={[...PROBE_TEMPLATES]}
              onRemoveBlock={removeEntry}
              onRemoveException={(value) => {
                setRulesExceptionText(rulesExceptionText.split("\n").filter((l) => l.trim() !== value).join("\n"));
              }}
            />
            <form
              className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                addEntry();
              }}
            >
              <Select value={entryKind} onValueChange={(v) => setEntryKind(v as (typeof BLOCK_KINDS)[number])}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">Turn away path</SelectItem>
                  <SelectItem value="allow">Let path through</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={entryPath}
                onChange={(e) => setEntryPath(e.target.value)}
                placeholder={entryKind === "regex" ? "^/path/.*$" : "/path/prefix"}
                className="flex-1 min-w-[200px] font-mono text-sm"
              />
              <Input
                value={entryNote}
                onChange={(e) => setEntryNote(e.target.value)}
                placeholder="Note (optional)"
                className="w-[180px]"
              />
              <Button type="submit" size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add</Button>
            </form>
            {entryError && <p className="text-xs text-destructive">{entryError}</p>}
            <p className="text-xs text-muted-foreground">
              Turn away answers 403 and counts toward bans like any probe. Let through skips a Block common probes rule for that path. Paths match from the start of the URL.
            </p>
          </div>

          <details className="rounded-lg border bg-muted/20 px-4 py-3">
            <summary className="flex cursor-pointer items-center justify-between text-sm font-medium">
              <span>Block common probes <span className="text-xs text-muted-foreground font-normal">· 23 rules · read-only</span></span>
              <span className="text-xs text-muted-foreground group-open:hidden details-show">Show</span>
              <span className="text-xs text-muted-foreground hidden group-open:inline details-hide">Hide</span>
            </summary>
            <div className="mt-3 space-y-3">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, path or category" className="max-w-xs" />
              <CommonRulesTable rules={[...filteredRules]} overrides={rulesDraft.rules} onToggle={toggleRule} />
            </div>
          </details>
        </CardContent>
        <div className="flex items-center justify-end gap-3 border-t bg-muted/30 px-4 py-3 rounded-b-xl">
          <span className="text-xs text-muted-foreground">{rulesDirty ? "Unsaved changes" : "Saved"}</span>
          <Button size="sm" onClick={() => void saveRules()} disabled={savingRules || !rulesDirty}>
            {savingRules ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </Card>

      {/* Response headers card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Response headers</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Added to HTTPS responses. They replace the app&apos;s own for the same header.
          </p>
        </CardHeader>
        <CardContent className="border-t pt-5">
          <SecurityHeadersFields value={headers} onChange={setHeaders} live={securityHeadersLive} />
        </CardContent>
        <div className="flex items-center justify-end gap-3 border-t bg-muted/30 px-4 py-3 rounded-b-xl">
          <span className="text-xs text-muted-foreground">{headersDirty ? "Unsaved changes" : "Saved"}</span>
          <Button size="sm" onClick={() => void saveHeaders()} disabled={savingHeaders || !headersDirty}>
            {savingHeaders ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </Card>

      <SecurityRecommendationsSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        recommendations={recommendationsList}
        onApplyAll={handleApplyAll}
        onIgnoreAll={handleIgnoreAll}
        onApply={handleApply}
        onIgnore={handleIgnore}
        onUndo={handleUndo}
      />
    </div>
  );
}

function Banner({ count, onReview, onApplyAll, onIgnoreAll }: { count: number; onReview: () => void; onApplyAll: () => void; onIgnoreAll: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{count} security {count === 1 ? "recommendation" : "recommendations"}</p>
        <p className="text-xs text-muted-foreground">Found by the latest scan. Nothing changes until you apply it.</p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onReview}>Review</Button>
        <Button size="sm" variant="outline" onClick={onApplyAll}>Apply all</Button>
        <Button size="sm" variant="ghost" onClick={onIgnoreAll}>Ignore all</Button>
      </div>
    </div>
  );
}

function TemplateCard({ template, on, onToggle }: { template: ProbeTemplate; on: boolean; onToggle: (next: boolean) => void }) {
  const letsThrough = template.letThrough ?? [];
  const turnAway = template.turnAway;
  return (
    <div className={cn("rounded-lg border p-3 space-y-2", on ? "bg-muted/40" : "bg-card")}>
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium leading-snug">{template.name}</h4>
        <Switch checked={on} onCheckedChange={onToggle} aria-label={`${template.name} template`} />
      </div>
      <p className="text-xs text-muted-foreground">{template.description}</p>
      {letsThrough.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Lets through</p>
          {letsThrough.map((p) => (
            <p key={`lt-${template.id}-${p}`} className="font-mono text-xs text-muted-foreground">{p}</p>
          ))}
        </div>
      )}
      {turnAway.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Turns away</p>
          {turnAway.slice(0, 4).map((t) => (
            <p key={`ta-${template.id}-${t.value}`} className="font-mono text-xs text-muted-foreground">{t.value}</p>
          ))}
          {turnAway.length > 4 && <p className="text-xs text-muted-foreground">+ {turnAway.length - 4} more</p>}
        </div>
      )}
    </div>
  );
}

function EntriesTable({ blocks, exceptions, templates, onRemoveBlock, onRemoveException }: { blocks: CustomBlock[]; exceptions: string[]; templates: ProbeTemplate[]; onRemoveBlock: (index: number) => void; onRemoveException: (value: string) => void }) {
  type Row = { kind: "allow" | "block"; path: string; template?: string; note?: string; index?: number; removable: boolean; action: () => void };
  const rows: Row[] = [
    ...exceptions.map<Row>((value) => ({ kind: "allow", path: value, removable: true, action: () => onRemoveException(value) })),
    ...blocks.map<Row>((b, i) => {
      const template = templates.find((t) => t.id === b.template)?.name;
      return {
        kind: "block",
        path: b.value,
        template,
        note: b.note,
        index: i,
        removable: !b.template,
        action: () => onRemoveBlock(i),
      };
    }),
  ];
  if (rows.length === 0) {
    return <p className="rounded-lg border bg-muted/20 px-4 py-4 text-xs text-muted-foreground">Nothing added.</p>;
  }
  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="grid grid-cols-[124px_1.5fr_1fr_76px] gap-3 items-center bg-muted px-4 py-2 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
        <span>Action</span>
        <span>Path</span>
        <span>Source</span>
        <span className="text-right">·</span>
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {rows.map((row, i) => (
          <div key={`${row.kind}-${row.path}-${i}`} className="grid grid-cols-[124px_1.5fr_1fr_76px] gap-3 items-center px-4 py-2 text-xs border-t">
            <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wide w-fit font-semibold", row.kind === "allow" ? "bg-status-success-muted text-status-success" : "bg-status-error-muted text-status-error")}>
              {row.kind === "allow" ? "Let through" : "Turn away"}
            </span>
            <span className="font-mono break-all">{row.path}{row.note ? <span className="block text-muted-foreground">{row.note}</span> : null}</span>
            <span>{row.template ? <span className="rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-semibold">{row.template}</span> : <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Manual</span>}</span>
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground justify-self-end disabled:opacity-40 disabled:cursor-not-allowed" disabled={!row.removable} onClick={row.action}>
              {row.removable ? <Trash2 className="size-3.5" /> : <span className="text-[10px] uppercase tracking-wide">Template</span>}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommonRulesTable({ rules, overrides, onToggle }: { rules: ProbeRule[]; overrides: RuleOverrides; onToggle: (id: string, off: boolean) => void }) {
  const ordered = [...rules].sort((a, b) => {
    const orderA = ORDER.indexOf(a.category);
    const orderB = ORDER.indexOf(b.category);
    if (orderA !== orderB) return orderA - orderB;
    return a.label.localeCompare(b.label);
  });
  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="grid grid-cols-[1.2fr_2fr_60px] gap-3 items-center bg-muted px-4 py-2 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
        <span>Rule</span>
        <span>Matches</span>
        <span className="text-right">·</span>
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {ordered.length === 0 && <p className="px-4 py-4 text-xs text-muted-foreground">Nothing matches.</p>}
        {ordered.map((r) => {
          const on = !(r.id in overrides && overrides[r.id] === false);
          const labelDefault = r.suggested ? "Off by default" : "On";
          return (
            <div key={r.id} className="grid grid-cols-[1.2fr_2fr_60px] gap-3 items-center px-4 py-2 text-xs border-t">
              <div>
                <p className="font-medium">{r.label}</p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{CATEGORY_LABEL[r.category] ?? r.category} · {labelDefault}</p>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground break-all">{r.pattern}</p>
              <span className="justify-self-end">
                <Switch checked={on} onCheckedChange={(v) => onToggle(r.id, !v)} aria-label={`${r.label} rule`} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}