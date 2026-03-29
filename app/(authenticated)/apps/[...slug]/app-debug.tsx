"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Copy, Check, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { toast } from "@/lib/messenger";

type DebugData = {
  compose: string | null;
  traefikConfig: string | null;
  containers: unknown[];
};

function CodeBlock({
  label,
  content,
  loading = false,
  defaultOpen = true,
}: {
  label: string;
  content: string | null;
  loading?: boolean;
  defaultOpen?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors group">
          <ChevronRight className="size-3.5 text-zinc-500 group-data-[state=open]:hidden" />
          <ChevronDown className="size-3.5 text-zinc-500 hidden group-data-[state=open]:block" />
          {label}
        </CollapsibleTrigger>
        {!loading && content && (
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            title="Copy to clipboard"
            aria-label={`Copy ${label} to clipboard`}
          >
            {copied ? (
              <Check className="size-3.5 text-status-success" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        )}
      </div>
      <CollapsibleContent>
        <pre className="p-4 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre leading-5">
          {loading ? (
            <span className="text-zinc-600 italic">Loading...</span>
          ) : content ?? (
            <span className="text-zinc-600 italic">
              Not available — only generated at deploy time for git-sourced apps.
            </span>
          )}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AppDebug({
  appId,
  orgId,
}: {
  appId: string;
  orgId: string;
}) {
  const [data, setData] = useState<DebugData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/debug`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load debug info");
    } finally {
      setLoading(false);
    }
  }, [appId, orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const containerJson = useMemo(() => {
    if (!data?.containers?.length) return null;
    return JSON.stringify(
      data.containers.length === 1 ? data.containers[0] : data.containers,
      null,
      2,
    );
  }, [data]);

  return (
    <div className="pt-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Generated config for this app — compose file, Traefik routing rules, and live container inspect data.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          className="shrink-0"
        >
          <RefreshCw className={`size-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-status-error/30 bg-status-error-muted px-4 py-3 text-sm text-status-error">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <CodeBlock
          label="Docker Compose"
          content={data?.compose ?? null}
          loading={loading}
        />
        <CodeBlock
          label="Traefik Config"
          content={data?.traefikConfig ?? null}
          loading={loading}
          defaultOpen={false}
        />
        <CodeBlock
          label="Container Inspect"
          content={containerJson}
          loading={loading}
          defaultOpen={false}
        />
      </div>
    </div>
  );
}
