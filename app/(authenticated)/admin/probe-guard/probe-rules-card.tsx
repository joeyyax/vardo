"use client";

import { useCallback, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/messenger";
import { useSystemSetting } from "@/app/(authenticated)/admin/settings/use-system-setting";
import { DEFAULT_INSTANCE_PROBE_GUARD, type InstanceProbeGuard } from "@/lib/probe-guard/settings";
import { BLOCK_KINDS, MAX_NOTE_LENGTH, blockProblem, type CustomBlock } from "@/lib/probe-guard/blocks";
import { exceptionProblem } from "@/lib/probe-guard/rules";
import { PROBE_RULES, type ProbeCategory } from "@/lib/probe-guard/rules";
import { PROBE_TEMPLATES, type ProbeTemplate, type TemplateSignal } from "@/lib/probe-guard/templates";

const ENDPOINT = "/api/v1/admin/probe-guard";

type Data = { settings: InstanceProbeGuard; configured?: boolean };

const CATEGORY_LABEL: Record<ProbeCategory, string> = {
  secrets: "Secrets",
  vcs: "Version control",
  wordpress: "WordPress",
  "db-admin": "Database admin",
  cgi: "CGI",
  framework: "Frameworks",
  "server-info": "Server info",
  backup: "Backups",
  traversal: "Traversal",
  router: "Routers",
};

function signalLine(signal: TemplateSignal): string {
  if ("image" in signal) return `image ${signal.image.source.toString()}`;
  if ("path" in signal) return signal.body ? `${signal.path} body ${signal.body.source}` : `path ${signal.path}`;
  if ("cookie" in signal) return `cookie ${signal.cookie}`;
  return `header ${signal.header}${signal.value ? ` value ${signal.value.source}` : ""}`;
}

/** One template's rows for the read-only templates table. */
function TemplateRow({ template }: { template: ProbeTemplate }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 align-top">
        <p className="font-medium">{template.name}</p>
      </td>
      <td className="py-2 align-top text-xs text-muted-foreground">
        {template.detect.map((s) => signalLine(s)).join(" · ")}
      </td>
      <td className="py-2 align-top text-xs text-muted-foreground">
        {(template.letThrough?.length ?? 0) + template.turnAway.length} entries
        <div className="mt-1 space-y-0.5">
          {(template.letThrough ?? []).map((p) => (
            <p key={`l-${p}`} className="font-mono text-[11px]">{p} · let through</p>
          ))}
          {template.turnAway.map((p) => (
            <p key={`t-${p.value}`} className="font-mono text-[11px]">{p.value} · turn away</p>
          ))}
        </div>
      </td>
      <td className="py-2 align-top text-xs text-muted-foreground">v{template.version}</td>
    </tr>
  );
}

/** Instance-wide entries: exceptions (let through) and blocks (turn away). */
export function ProbeRulesCard() {
  const [settings, setSettings] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);
  const [baseline, setBaseline] = useState<InstanceProbeGuard>(DEFAULT_INSTANCE_PROBE_GUARD);
  const [exceptionInput, setExceptionInput] = useState("");
  const [blockKind, setBlockKind] = useState<(typeof BLOCK_KINDS)[number]>("prefix");
  const [blockInput, setBlockInput] = useState("");
  const [blockNote, setBlockNote] = useState("");
  const [filter, setFilter] = useState("");

  const onLoad = useCallback((data: Data) => {
    setSettings(data.settings);
    setBaseline(data.settings);
  }, []);

  const { loading, saving, save } = useSystemSetting<Data>(ENDPOINT, { label: "Probe rules", onLoad });

  const dirty =
    JSON.stringify(settings.exceptions) !== JSON.stringify(baseline.exceptions) ||
    JSON.stringify(settings.blocks) !== JSON.stringify(baseline.blocks);

  const filteredRules = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return PROBE_RULES;
    return PROBE_RULES.filter((r) =>
      r.id.toLowerCase().includes(q) ||
      r.label.toLowerCase().includes(q) ||
      CATEGORY_LABEL[r.category].toLowerCase().includes(q) ||
      r.pattern.toLowerCase().includes(q),
    );
  }, [filter]);

  const addException = () => {
    const value = exceptionInput.trim();
    if (!value) return;
    const issue = exceptionProblem(value);
    if (issue) {
      toast.error(issue);
      return;
    }
    if (settings.exceptions.includes(value)) {
      toast.error("Already in the list");
      return;
    }
    setSettings((s) => ({ ...s, exceptions: [...s.exceptions, value] }));
    setExceptionInput("");
  };

  const removeException = (value: string) =>
    setSettings((s) => ({ ...s, exceptions: s.exceptions.filter((e) => e !== value) }));

  const addBlock = () => {
    const value = blockInput.trim();
    if (!value) return;
    const candidate: CustomBlock = {
      kind: blockKind,
      value,
      ...(blockNote.trim() ? { note: blockNote.trim().slice(0, MAX_NOTE_LENGTH) } : {}),
    };
    const issue = blockProblem(candidate);
    if (issue) {
      toast.error(issue);
      return;
    }
    if (settings.blocks.some((b) => b.kind === candidate.kind && b.value === candidate.value)) {
      toast.error("Already in the list");
      return;
    }
    setSettings((s) => ({ ...s, blocks: [...s.blocks, candidate] }));
    setBlockInput("");
    setBlockNote("");
  };

  const removeBlock = (idx: number) =>
    setSettings((s) => ({ ...s, blocks: s.blocks.filter((_, i) => i !== idx) }));

  if (loading) {
    return (
      <Card id="probe-rules" variant="surface">
        <CardContent className="py-6 flex justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="probe-rules" variant="surface">
      <CardHeader>
        <div className="space-y-1">
          <CardTitle>Probe rules</CardTitle>
          <p className="text-xs text-muted-foreground">Entries here apply to every app. An app can add its own on top.</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Instance entries */}
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="type-label text-muted-foreground">Let-through paths · {settings.exceptions.length}</p>
            </div>
            <ul className="divide-y rounded-md border">
              {settings.exceptions.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">Nothing added.</li>
              ) : (
                settings.exceptions.map((p) => (
                  <li key={p} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs">{p}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${p}`}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => removeException(p)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Path"
                className="font-mono flex-1 min-w-[200px]"
                placeholder="/internal-admin/"
                value={exceptionInput}
                onChange={(e) => setExceptionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addException();
                  }
                }}
              />
              <Button size="sm" type="button" onClick={addException}><Plus className="size-3.5" /> Let through</Button>
            </div>
            <p className="text-xs text-muted-foreground">Let-through paths skip a built-in rule for matching requests. They don&apos;t lift a custom block.</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="type-label text-muted-foreground">Turn-away entries · {settings.blocks.length}</p>
            </div>
            <ul className="divide-y rounded-md border">
              {settings.blocks.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">Nothing added.</li>
              ) : (
                settings.blocks.map((b, i) => (
                  <li key={`${b.kind}-${b.value}-${i}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs">
                        <span className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase">{b.kind}</span>{" "}
                        <span className="font-mono">{b.value}</span>
                      </p>
                      {b.note && <p className="text-xs text-muted-foreground">{b.note}</p>}
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${b.value}`}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => removeBlock(i)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={blockKind} onValueChange={(v) => setBlockKind(v as (typeof BLOCK_KINDS)[number])}>
                <SelectTrigger className="w-[110px]" aria-label="Kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="prefix">prefix</SelectItem>
                  <SelectItem value="exact">exact</SelectItem>
                  <SelectItem value="regex">regex</SelectItem>
                </SelectContent>
              </Select>
              <Input
                aria-label="Path or pattern"
                className="font-mono flex-1 min-w-[200px]"
                placeholder="/path/prefix   (regex for pattern)"
                value={blockInput}
                onChange={(e) => setBlockInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addBlock();
                  }
                }}
              />
              <Input
                aria-label="Note"
                className="w-[200px]"
                placeholder="Note (optional)"
                value={blockNote}
                onChange={(e) => setBlockNote(e.target.value)}
              />
              <Button size="sm" type="button" onClick={addBlock}><Plus className="size-3.5" /> Turn away</Button>
            </div>
            <p className="text-xs text-muted-foreground">Turn-away entries answer 403 and count toward bans like any probe.</p>
          </div>
        </div>

        {/* Built-in rules */}
        <details className="rounded-md border">
          <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm">
            <span>
              <span className="font-medium">Built-in rules</span>{" "}
              <span className="text-xs text-muted-foreground">· {PROBE_RULES.length} · Block common probes</span>
            </span>
            <span className="text-xs text-muted-foreground">Show</span>
          </summary>
          <div className="space-y-2 border-t px-3 py-3">
            <Input
              aria-label="Filter built-in rules"
              placeholder="Filter by name, category or pattern"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-sm"
            />
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-1.5">Rule</th>
                    <th className="px-3 py-1.5">Pattern</th>
                    <th className="px-3 py-1.5 w-16 text-right">Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRules.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-1.5">
                        <p className="font-medium">{r.label}</p>
                        <p className="text-[11px] text-muted-foreground">{CATEGORY_LABEL[r.category]} · {r.id}{r.suggested ? " · off by default" : ""}</p>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground break-all">{r.pattern}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>

        {/* Templates */}
        <div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-2">
          <p className="type-label text-muted-foreground">Templates · {PROBE_TEMPLATES.length}</p>
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-1.5">Template</th>
                  <th className="px-3 py-1.5">Scan recognizes</th>
                  <th className="px-3 py-1.5">Entries</th>
                  <th className="px-3 py-1.5 w-12">Version</th>
                </tr>
              </thead>
              <tbody>
                {PROBE_TEMPLATES.map((t) => (
                  <TemplateRow key={t.id} template={t as ProbeTemplate} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Each template says what it changes and how a scan recognizes the stack. Apps add templates on their own Security page.</p>
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <span className={`text-xs ${dirty ? "text-status-warning" : "text-muted-foreground"}`}>{dirty ? "Unsaved changes" : "Saved"}</span>
          <Button
            size="sm"
            disabled={saving || !dirty}
            onClick={() => {
              const patch = { exceptions: settings.exceptions, blocks: settings.blocks };
              setBaseline(settings);
              void save(patch as unknown as Record<string, unknown>);
            }}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}