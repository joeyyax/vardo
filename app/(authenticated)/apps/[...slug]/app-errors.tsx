"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/lib/messenger";

type Issue = {
  id: number;
  title: string;
  culprit: string;
  level: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
  type: string;
  metadata: {
    type?: string;
    value?: string;
    filename?: string;
    function?: string;
  };
  permalink: string | null;
};

export function AppErrors({ orgId, appId }: { orgId: string; appId: string }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/errors`);
      if (!res.ok) {
        toast.error("Failed to fetch errors");
        return;
      }
      const data = await res.json();
      setIssues(data.issues ?? []);
      setAvailable(data.available !== false);
    } catch {
      toast.error("Failed to fetch errors");
    } finally {
      setLoading(false);
    }
  }, [orgId, appId]);

  useEffect(() => {
    fetchIssues();
  }, [fetchIssues]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading errors...
      </div>
    );
  }

  if (!available) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <AlertTriangle className="mx-auto mb-3 size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          GlitchTip is not reachable. It may still be starting up — check back in a moment.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Errors captured by GlitchTip (Sentry-compatible). Apps receive a <code className="text-xs">GLITCHTIP_DSN</code> env var automatically.
        </p>
        <Button variant="outline" size="sm" onClick={fetchIssues}>
          <RefreshCw className="mr-1.5 size-3.5" />
          Refresh
        </Button>
      </div>

      {issues.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No errors recorded yet.</p>
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} orgId={orgId} appId={appId} />
          ))}
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue, orgId, appId }: { issue: Issue; orgId: string; appId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [event, setEvent] = useState<{ entries: { type: string; data: unknown }[] } | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(false);

  async function loadEvent() {
    if (event) {
      setExpanded(!expanded);
      return;
    }
    setExpanded(true);
    setLoadingEvent(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/errors/${issue.id}`);
      if (res.ok) {
        const data = await res.json();
        setEvent(data.event);
      }
    } catch {
      // silently fail
    } finally {
      setLoadingEvent(false);
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-2">
        <button
          className="flex flex-1 items-start gap-3 text-left min-w-0"
          onClick={loadEvent}
        >
          <LevelIcon level={issue.level} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm truncate">{issue.title}</span>
              <Badge variant="secondary" className="text-xs shrink-0">
                {issue.count}×
              </Badge>
              {issue.status === "resolved" && (
                <Badge variant="outline" className="text-xs text-green-600">Resolved</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              {issue.culprit || issue.metadata?.filename || "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              First seen {formatRelative(issue.firstSeen)} · Last seen {formatRelative(issue.lastSeen)}
            </div>
          </div>
        </button>
        {issue.permalink && (
          <a
            href={issue.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 mt-1 p-1 text-muted-foreground hover:text-foreground transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {expanded && (
        <div className="mt-3 ml-8">
          {loadingEvent ? (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              Loading stack trace...
            </div>
          ) : event ? (
            <StackTrace entries={event.entries} />
          ) : (
            <p className="text-xs text-muted-foreground">No event data available.</p>
          )}
        </div>
      )}
    </div>
  );
}

function StackTrace({ entries }: { entries: { type: string; data: unknown }[] }) {
  const exceptionEntry = entries.find((e) => e.type === "exception");
  if (!exceptionEntry) {
    return <p className="text-xs text-muted-foreground">No stack trace available.</p>;
  }

  const data = exceptionEntry.data as { values?: { type: string; value: string; stacktrace?: { frames: StackFrame[] } }[] };
  const values = data.values ?? [];

  return (
    <div className="space-y-3">
      {values.map((exc, i) => (
        <div key={i}>
          <div className="text-xs font-medium text-destructive">
            {exc.type}: {exc.value}
          </div>
          {exc.stacktrace?.frames && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[11px] leading-relaxed">
              {exc.stacktrace.frames
                .slice()
                .reverse()
                .map((frame, j) => (
                  <div key={j} className="hover:bg-muted-foreground/10">
                    <span className="text-muted-foreground">{frame.filename}</span>
                    {frame.lineNo && <span>:{frame.lineNo}</span>}
                    {frame.function && (
                      <span className="text-foreground"> in <strong>{frame.function}</strong></span>
                    )}
                  </div>
                ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

type StackFrame = {
  filename: string;
  lineNo: number | null;
  colNo: number | null;
  function: string | null;
  context: [number, string][];
};

function LevelIcon({ level }: { level: string }) {
  const color = level === "error" || level === "fatal"
    ? "text-destructive"
    : level === "warning"
    ? "text-yellow-500"
    : "text-muted-foreground";
  return <AlertTriangle className={`size-4 shrink-0 mt-0.5 ${color}`} />;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
