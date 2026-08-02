"use client";

import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  Loader2, Pause, Play, ArrowDown, ArrowUp, X, Copy, Check, Download,
  Database, HardDrive, Search, ChevronUp, ChevronDown, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/messenger";
import { useVisibilityKey } from "@/hooks/use-visible";
import {
  detectLevel, assignLevels, countLevels, filterByLevel, type LogLevel,
} from "@/lib/logging/levels";
import { highlightLine, serviceColor } from "@/lib/logging/highlight";
import { findMatches, matchedLines, filterToMatches, stepMatch } from "@/lib/logging/search";
import {
  capLines, mergeOlder, historyUrlFor, SCROLLBACK_OPTIONS, DEFAULT_SCROLLBACK,
} from "@/lib/logging/buffer";

export { detectLevel as detectLogLevel };

export function highlightLogLine(text: string): string {
  return highlightLine(text);
}

type ViewLine = {
  text: string;
  html: string;
  level: LogLevel;
  /** Compose service the line came from, in the all-services view. */
  service?: string;
};

/** Build render-ready lines, threading levels so stack traces stay one color. */
function toViewLines(input: { text: string; service?: string }[], previous?: LogLevel): ViewLine[] {
  const levels = assignLevels(input.map((l) => l.text));
  if (previous && input.length > 0) levels[0] = detectLevel(input[0].text, previous);
  return input.map((line, i) => ({
    text: line.text,
    service: line.service,
    html: highlightLine(line.text),
    level: levels[i],
  }));
}

// --- Shared terminal output component ---

const LEVEL_LABELS: Record<LogLevel, string> = {
  error: "Errors",
  warn: "Warnings",
  info: "Info",
  debug: "Debug",
  other: "Other",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  info: "text-blue-400",
  debug: "text-zinc-500",
  other: "text-zinc-400",
};

const CHIP_ORDER: LogLevel[] = ["error", "warn", "info", "debug", "other"];

type TerminalOutputProps = {
  lines: { text: string; html: string; level?: LogLevel; service?: string }[];
  height?: string;
  /** Grow the pane to the bottom of the viewport instead of a fixed height. */
  fill?: boolean;
  showFilters?: boolean;
  onLoadOlder?: () => Promise<void>;
  hasOlder?: boolean;
  className?: string;
};

export function TerminalOutput({
  lines,
  height = "min-h-40 max-h-[500px]",
  fill = false,
  showFilters = true,
  onLoadOlder,
  hasOlder = false,
  className,
}: TerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolledRef = useRef(false);
  const [activeFilters, setActiveFilters] = useState<Set<LogLevel>>(new Set());
  const [query, setQuery] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [activeMatch, setActiveMatch] = useState(-1);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [copied, setCopied] = useState(false);

  const levelCounts = useMemo(() => countLevels(lines), [lines]);

  const levelFiltered = useMemo(
    () => filterByLevel(lines, activeFilters),
    [lines, activeFilters],
  );

  const visibleLines = useMemo(() => {
    if (!onlyMatches || !query) return levelFiltered;
    const matched = matchedLines(findMatches(levelFiltered.map((l) => l.text), query));
    return filterToMatches(levelFiltered, matched);
  }, [levelFiltered, onlyMatches, query]);

  const matches = useMemo(
    () => findMatches(visibleLines.map((l) => l.text), query),
    [visibleLines, query],
  );

  // Only matched lines are re-marked; the rest keep the HTML built at ingest.
  const markedHtml = useMemo(() => {
    const map = new Map<number, string>();
    if (!query) return map;
    for (const line of matchedLines(matches)) {
      map.set(line, highlightLine(visibleLines[line].text, query));
    }
    return map;
  }, [matches, visibleLines, query]);

  const active = activeMatch >= 0 ? matches[activeMatch] : undefined;

  useEffect(() => {
    setActiveMatch(matches.length > 0 ? 0 : -1);
    // Re-anchoring on every keystroke is the point — a new query starts at its first hit.
  }, [query, matches.length]);

  const step = useCallback((delta: number) => {
    setActiveMatch((current) => stepMatch(current, matches.length, delta));
    setAutoScroll(false);
    userScrolledRef.current = true;
  }, [matches.length]);

  // Center the current match without scrolling the page around it
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    const row = container.querySelector(`[data-line="${active.line}"]`);
    if (!row) return;
    const pane = container.getBoundingClientRect();
    const line = row.getBoundingClientRect();
    container.scrollTop += line.top - pane.top - (pane.height - line.height) / 2;
  }, [active]);

  // Fill the rest of the viewport
  const [fillHeight, setFillHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!fill) return;
    function measure() {
      const top = containerRef.current?.getBoundingClientRect().top;
      if (!top || top <= 0) return;
      setFillHeight(Math.max(280, window.innerHeight - top - 24));
    }
    measure();
    window.addEventListener("resize", measure);
    const observer = headerRef.current ? new ResizeObserver(measure) : null;
    if (headerRef.current) observer?.observe(headerRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [fill]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visibleLines, autoScroll, fillHeight]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (!atBottom && !userScrolledRef.current) {
      userScrolledRef.current = true;
      setAutoScroll(false);
    } else if (atBottom && userScrolledRef.current) {
      userScrolledRef.current = false;
      setAutoScroll(true);
    }
  }, []);

  function scrollToBottom() {
    setAutoScroll(true);
    userScrolledRef.current = false;
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }

  function toggleFilter(level: LogLevel) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  async function loadOlder() {
    if (!onLoadOlder || loadingOlder) return;
    const el = containerRef.current;
    const before = el?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      await onLoadOlder();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before;
      }));
    } finally {
      setLoadingOlder(false);
    }
  }

  function plainText() {
    return visibleLines.map((l) => (l.service ? `${l.service} | ${l.text}` : l.text)).join("\n");
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(plainText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function download() {
    const url = URL.createObjectURL(new Blob([plainText()], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const typing = e.target instanceof HTMLInputElement;
    if (typing) {
      if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      if (e.key === "Escape") { setQuery(""); searchRef.current?.blur(); }
      return;
    }
    if (e.key === "n" || e.key === "N") { e.preventDefault(); step(e.key === "n" ? 1 : -1); }
    if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
  }

  const filtering = activeFilters.size > 0 || (onlyMatches && query.length > 0);

  return (
    <div
      onKeyDown={onKeyDown}
      className={cn("rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden", className)}
    >
      {/* Control bar */}
      {showFilters && (
        <div ref={headerRef} className="border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <div className="relative flex-1 min-w-32 max-w-md">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-zinc-500" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find in logs"
                aria-label="Find in logs"
                className="w-full rounded bg-zinc-950 border border-zinc-800 pl-7 pr-2 py-1 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
            </div>
            {query && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-zinc-500 tabular-nums" aria-live="polite">
                  {matches.length === 0 ? "No matches" : `${activeMatch + 1} of ${matches.length}`}
                </span>
                <button
                  onClick={() => step(-1)}
                  disabled={matches.length === 0}
                  className="text-zinc-500 hover:text-zinc-200 disabled:opacity-40 p-0.5"
                  title="Previous match (N)"
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <button
                  onClick={() => step(1)}
                  disabled={matches.length === 0}
                  className="text-zinc-500 hover:text-zinc-200 disabled:opacity-40 p-0.5"
                  title="Next match (n)"
                >
                  <ChevronDown className="size-3.5" />
                </button>
                <button
                  onClick={() => setOnlyMatches((v) => !v)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs transition-colors",
                    onlyMatches ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800",
                  )}
                  title="Hide lines without a match"
                >
                  Only matches
                </button>
                <button
                  onClick={() => setQuery("")}
                  className="text-zinc-500 hover:text-zinc-300 p-0.5"
                  title="Clear search"
                >
                  <X className="size-3" />
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 px-3 pb-1.5">
            <div className="flex items-center gap-1 flex-wrap">
              {CHIP_ORDER.map((level) => {
                const count = levelCounts[level];
                // A lone "Errors" chip on a clean stream reads as an alarm.
                if (count === 0) return null;
                const isActive = activeFilters.has(level);
                return (
                  <button
                    key={level}
                    onClick={() => toggleFilter(level)}
                    aria-pressed={isActive}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                      isActive ? "bg-zinc-700 text-zinc-100" : `${LEVEL_COLORS[level]} hover:bg-zinc-800`,
                    )}
                  >
                    {LEVEL_LABELS[level]}
                    <span className={cn("tabular-nums", !isActive && LEVEL_COLORS[level])}>
                      {count}
                    </span>
                  </button>
                );
              })}
              {activeFilters.size > 0 && (
                <button
                  onClick={() => setActiveFilters(new Set())}
                  className="text-zinc-500 hover:text-zinc-300 ml-1 p-0.5"
                  title="Clear filters"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 tabular-nums whitespace-nowrap">
                {filtering
                  ? `${visibleLines.length.toLocaleString()} / ${lines.length.toLocaleString()}`
                  : lines.length.toLocaleString()} lines
              </span>
              <button
                onClick={copyToClipboard}
                className="text-zinc-500 hover:text-zinc-300 p-0.5 transition-colors"
                title="Copy to clipboard"
              >
                {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
              </button>
              <button
                onClick={download}
                className="text-zinc-500 hover:text-zinc-300 p-0.5 transition-colors"
                title="Download"
              >
                <Download className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log output */}
      <div className="relative">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          // Focusable so the pane scrolls by keyboard and n/N step matches.
          tabIndex={0}
          role="log"
          aria-label="Log output"
          style={fill && fillHeight ? { height: fillHeight } : undefined}
          onCopy={(e) => {
            // Intercept copy to provide clean plain text instead of HTML spans
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) return;

            // Walk selected nodes and extract the raw text from data attributes
            const range = selection.getRangeAt(0);
            const fragment = range.cloneContents();
            const copied: string[] = [];
            fragment.querySelectorAll("[data-raw]").forEach((el) => {
              copied.push((el as HTMLElement).dataset.raw || "");
            });

            if (copied.length > 0) {
              e.preventDefault();
              e.clipboardData.setData("text/plain", copied.join("\n"));
            }
          }}
          className={cn(
            "p-4 overflow-auto font-mono text-xs leading-5 select-text",
            (!fill || !fillHeight) && height,
          )}
        >
          {onLoadOlder && hasOlder && lines.length > 0 && (
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="w-full mb-2 flex items-center justify-center gap-1.5 rounded border border-dashed border-zinc-800 py-1 text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
            >
              {loadingOlder
                ? <><Loader2 className="size-3 animate-spin" />Loading</>
                : <><ArrowUp className="size-3" />Load older lines</>}
            </button>
          )}
          {visibleLines.length === 0 ? (
            <div className="text-zinc-500">
              {lines.length === 0 ? "No output." : "No lines match the current filter."}
            </div>
          ) : (
            visibleLines.map((line, i) => (
              <div
                key={i}
                data-line={i}
                data-raw={line.service ? `${line.service} | ${line.text}` : line.text}
                className={cn(
                  "flex gap-2 text-zinc-300 hover:bg-white/5 px-1 -mx-1 rounded",
                  active?.line === i && "bg-white/5",
                )}
              >
                {line.service && (
                  <span className={cn("select-none w-24 shrink-0 truncate", serviceColor(line.service))}>
                    {line.service}
                  </span>
                )}
                <span
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words"
                  dangerouslySetInnerHTML={{
                    __html: active?.line === i
                      ? highlightLine(line.text, query, active.ordinal)
                      : markedHtml.get(i) ?? line.html,
                  }}
                />
              </div>
            ))
          )}
        </div>

        {/* Scroll to bottom indicator */}
        {!autoScroll && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors shadow-lg"
          >
            <ArrowDown className="size-3" />
            Bottom
          </button>
        )}
      </div>
    </div>
  );
}

// --- Static log display (deployment logs) ---

type StaticLogProps = {
  log: string;
  maxHeight?: string;
};

export function DeploymentLog({ log, maxHeight = "max-h-96" }: StaticLogProps) {
  const lines = useMemo(
    () => toViewLines(log.split("\n").filter(Boolean).map((text) => ({ text }))),
    [log],
  );

  return (
    <div className="border-t">
      <TerminalOutput lines={lines} height={maxHeight} showFilters={lines.length > 10} />
    </div>
  );
}

// --- Streaming log viewer ---

type LogSource = "loki" | "docker" | null;

type StreamLine = { text: string; service?: string };

type InitEvent = {
  source: LogSource;
  services?: string[];
  lines?: StreamLine[];
};

type LogViewerProps = {
  streamUrl: string;
  maxLines?: number;
};

export function LogViewer({ streamUrl, maxLines = DEFAULT_SCROLLBACK }: LogViewerProps) {
  const [lines, setLines] = useState<ViewLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [paused, setPaused] = useState(false);
  const [manualReconnect, setManualReconnect] = useState(0);
  const [scrollback, setScrollback] = useState(maxLines);
  const [allServices, setAllServices] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  // Tagged with the stream it came from so a URL change clears it without a
  // setState inside the connection effect.
  const [sourceState, setSourceState] = useState<{ url: string; source: LogSource; services: string[] }>({
    url: streamUrl,
    source: null,
    services: [],
  });

  const url = allServices ? appendParam(streamUrl, "services", "all") : streamUrl;
  const logSource = sourceState.url === url ? sourceState.source : null;
  const services = sourceState.services;

  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  const scrollbackRef = useRef(scrollback);
  useEffect(() => {
    scrollbackRef.current = scrollback;
  }, [scrollback]);
  const visKey = useVisibilityKey();

  useEffect(() => {
    // Don't connect if tab is hidden
    if (typeof document !== "undefined" && document.hidden) return;

    const es = new EventSource(url);

    es.onopen = () => setConnected(true);

    function append(incoming: StreamLine[]) {
      if (pausedRef.current || incoming.length === 0) return;
      setLines((prev) => capLines(
        [...prev, ...toViewLines(incoming, prev[prev.length - 1]?.level)],
        scrollbackRef.current,
      ));
    }

    es.addEventListener("init", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as InitEvent;
        setSourceState({ url, source: data.source ?? null, services: data.services ?? [] });
        setHasOlder(true);
        if (pausedRef.current) return;
        setLines(capLines(toViewLines(data.lines ?? []), scrollbackRef.current));
      } catch {
        // skip malformed init
      }
    });

    function handleBatch(event: MessageEvent) {
      try {
        append(JSON.parse(event.data) as StreamLine[]);
      } catch {
        // Skip malformed messages
      }
    }

    function handleSingle(event: MessageEvent) {
      try {
        append([{ text: JSON.parse(event.data) as string }]);
      } catch {
        // Skip malformed messages
      }
    }

    es.addEventListener("logs", handleBatch);
    es.addEventListener("log", handleSingle);

    // Handle stream timeout — show resume button
    es.addEventListener("timeout", () => {
      setConnected(false);
      setTimedOut(true);
      es.close();
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
    };
  }, [url, visKey, manualReconnect]);

  const loadOlder = useCallback(async () => {
    const depth = lines.length + 500;
    const historyUrl = historyUrlFor(url, { tail: String(depth) });
    try {
      const res = await fetch(historyUrl);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json() as { lines?: StreamLine[] };
      const older = toViewLines(data.lines ?? []);
      setLines((prev) => {
        const merged = mergeOlder(older, prev);
        if (merged.length === prev.length) setHasOlder(false);
        return merged;
      });
      setScrollback((prev) => Math.max(prev, depth));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load older lines");
    }
  }, [lines.length, url]);

  return (
    <div className="space-y-2">
      {/* Stream toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={`size-2 rounded-full ${connected ? "bg-status-success" : timedOut ? "bg-status-warning" : "bg-status-error"}`} />
          <span className="text-xs text-muted-foreground" aria-live="polite" aria-atomic="true">
            {connected ? "Streaming" : timedOut ? "Paused" : lines.length > 0 ? "Reconnecting..." : "Disconnected"}
          </span>
          {logSource && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground border border-zinc-800 rounded px-1.5 py-0.5">
              {logSource === "loki" ? (
                <><Database className="size-3" />Loki</>
              ) : (
                <><HardDrive className="size-3" />Container logs</>
              )}
            </span>
          )}
          {services.length > 1 && (
            <button
              onClick={() => setAllServices((v) => !v)}
              aria-pressed={allServices}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                allServices
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              <Layers className="size-3" />
              All services
            </button>
          )}
          {timedOut && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => { setTimedOut(false); setManualReconnect((k) => k + 1); }}
            >
              <Play className="size-3 mr-1" />
              Resume
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <label className="sr-only" htmlFor="log-scrollback">Scrollback</label>
          <select
            id="log-scrollback"
            value={scrollback}
            onChange={(e) => setScrollback(Number(e.target.value))}
            className="rounded border bg-transparent px-1.5 py-1 text-xs text-muted-foreground"
          >
            {SCROLLBACK_OPTIONS.map((size) => (
              <option key={size} value={size}>{size.toLocaleString()} lines</option>
            ))}
          </select>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setPaused(!paused)}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setLines([])}
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Terminal output */}
      {lines.length === 0 && !connected ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-xs text-zinc-500 font-mono">No logs available. Is the project running?</p>
        </div>
      ) : lines.length === 0 && connected ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-mono">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for output...
          </div>
        </div>
      ) : (
        <TerminalOutput lines={lines} fill onLoadOlder={loadOlder} hasOlder={hasOlder} />
      )}
    </div>
  );
}

function appendParam(url: string, key: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${value}`;
}
