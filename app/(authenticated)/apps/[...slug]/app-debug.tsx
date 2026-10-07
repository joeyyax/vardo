"use client";

import { copyToClipboard } from "@/lib/clipboard";
import { useState, useCallback, useEffect, useMemo } from "react";
import { Copy, Check, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { toast } from "@/lib/messenger";
import "@/components/surface-terminal.css";

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

  const handleCopy = useCallback(async () => {
    if (!content) return;
    if (!(await copyToClipboard(content))) return;
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="surface-terminal rounded-lg bg-background overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 bg-background-deep">
        <CollapsibleTrigger className="type-h4 flex items-center gap-1.5 text-foreground/80 hover:text-foreground transition-colors group">
          <ChevronRight className="size-3.5 text-muted-foreground group-data-[state=open]:hidden" />
          <ChevronDown className="size-3.5 text-muted-foreground hidden group-data-[state=open]:block" />
          {label}
        </CollapsibleTrigger>
        {!loading && content && (
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
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
        <pre className="p-4 text-xs text-foreground font-mono overflow-x-auto whitespace-pre leading-5">
          {loading ? (
            <span className="text-muted-foreground italic">Loading...</span>
          ) : content ?? (
            <span className="text-muted-foreground italic">
              Not available — only generated at deploy time for git-sourced apps.
            </span>
          )}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

type DebugResult = { data: DebugData } | { error: string };

async function requestDebug(url: string): Promise<DebugResult> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return { data: await res.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't load debug info" };
  }
}

export function AppDebug({
  appId,
  orgId,
}: {
  appId: string;
  orgId: string;
}) {
  const debugUrl = `/api/v1/organizations/${orgId}/apps/${appId}/debug`;
  const [data, setData] = useState<DebugData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestedUrl, setRequestedUrl] = useState(debugUrl);

  if (requestedUrl !== debugUrl) {
    setRequestedUrl(debugUrl);
    setLoading(true);
    setError(null);
  }

  const applyResult = useCallback((result: DebugResult) => {
    if ("data" in result) setData(result.data);
    else setError(result.error);
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    applyResult(await requestDebug(debugUrl));
  }, [debugUrl, applyResult]);

  useEffect(() => {
    let cancelled = false;
    requestDebug(debugUrl).then((result) => {
      if (!cancelled) applyResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [debugUrl, applyResult]);

  const containerJson = useMemo(() => {
    if (!data?.containers?.length) return null;
    return JSON.stringify(
      data.containers.length === 1 ? data.containers[0] : data.containers,
      null,
      2,
    );
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Generated config for this app — compose file, Traefik routing rules and live container inspect data.
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
        <div className="squircle rounded-lg bg-status-error-muted px-4 py-3 text-sm text-status-error border border-status-error-edge">
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
          label="Traefik config"
          content={data?.traefikConfig ?? null}
          loading={loading}
          defaultOpen={false}
        />
        <CodeBlock
          label="Container inspect"
          content={containerJson}
          loading={loading}
          defaultOpen={false}
        />
      </div>
    </div>
  );
}
