"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Loader2, Pause, Play, ArrowDown, X, Copy, Check, Database, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVisibilityKey } from "@/lib/hooks/use-visible";

type LogLine = {
  id: number;
  text: string;
  html: string;
  level?: LogLevel;
};

type LogLevel = "error" | "warn" | "info" | "debug" | "other";

// Log syntax highlighting patterns
const PATTERNS: [RegExp, string][] = [
  // Timestamps: ISO, common log formats
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "text-zinc-500"],
  // Error levels
  [/\b(ERROR|FATAL|PANIC|CRIT(ICAL)?)\b/gi, "text-red-400 font-semibold"],
  [/\b(WARN(ING)?)\b/gi, "text-yellow-400"],
  [/\b(INFO)\b/gi, "text-blue-400"],
  [/\b(DEBUG|TRACE)\b/gi, "text-zinc-500"],
  // HTTP methods
  [/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g, "text-cyan-400 font-medium"],
  // HTTP status codes
  [/\b([2]\d{2})\b/g, "text-status-success"],
  [/\b([3]\d{2})\b/g, "text-status-info"],
  [/\b([4]\d{2})\b/g, "text-status-warning"],
  [/\b([5]\d{2})\b/g, "text-status-error"],
  // URLs and paths
  [/https?:\/\/[^\s"']+/g, "text-status-info underline"],
  [/\/[a-zA-Z0-9\-._~/]+/g, "text-zinc-400"],
  // Quoted strings
  [/"[^"]*"/g, "text-amber-300/80"],
  // Numbers (standalone)
  [/\b\d+(\.\d+)?(ms|s|m|MB|KB|GB|B)?\b/g, "text-purple-300/80"],
  // Deploy stage markers — parent[child] format
  [/\[deploy\]\[compose\]/g, "text-status-info font-medium"],
  [/\[build\]\[nixpacks\]/g, "text-amber-300/80 font-medium"],
  [/\[build\]\[docker\]/g, "text-amber-300/80 font-medium"],
  // Single markers
  [/\[deploy\]/g, "text-status-info font-medium"],
  [/\[docker\]/g, "text-status-info/70 font-medium"],
  [/\[health\]/g, "text-status-success font-medium"],
  [/\[build\]/g, "text-amber-300/80 font-medium"],
  [/\[nixpacks\]/g, "text-violet-300/80 font-medium"],
  [/\[compat\]/g, "text-status-warning font-medium"],
  [/\[error\]/g, "text-status-error font-medium"],
];

export { detectLevel as detectLogLevel };

function detectLevel(text: string): LogLevel {
  if (/\b(ERROR|FATAL|PANIC|CRIT(ICAL)?)\b/i.test(text) || /\[error\]/i.test(text) || /\b[5]\d{2}\b/.test(text)) return "error";
  if (/\b(WARN(ING)?)\b/i.test(text) || /\[compat\]/i.test(text) || /\b[4]\d{2}\b/.test(text)) return "warn";
  if (/\b(INFO)\b/i.test(text) || /\[(deploy|health|docker)\]/i.test(text)) return "info";
  if (/\b(DEBUG|TRACE)\b/i.test(text)) return "debug";
  return "other";
}

export function highlightLogLine(text: string): string {
  return highlightLine(text);
}

function highlightLine(text: string): string {
  // Escape HTML first
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Apply patterns — wrap matches in spans
  const replacements: { start: number; end: number; replacement: string }[] = [];

  for (const [pattern, className] of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(html)) !== null) {
      const overlaps = replacements.some(
        (r) => match!.index < r.end && match!.index + match![0].length > r.start
      );
      if (!overlaps) {
        replacements.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: `<span class="${className}">${match[0]}</span>`,
        });
      }
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  for (const { start, end, replacement } of replacements) {
    html = html.slice(0, start) + replacement + html.slice(end);
  }

  return html;
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

type TerminalOutputProps = {
  lines: { text: string; html: string; level?: LogLevel }[];
  height?: string;
  showFilters?: boolean;
  className?: string;
};

export function TerminalOutput({ lines, height = "h-[500px]", showFilters = true, className }: TerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolledRef = useRef(false);
  const [activeFilters, setActiveFilters] = useState<Set<LogLevel>>(new Set());

  // Count lines by level
  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
    for (const line of lines) {
      const level = line.level || detectLevel(line.text);
      counts[level]++;
    }
    return counts;
  }, [lines]);

  // Filter lines
  const filteredLines = useMemo(() => {
    if (activeFilters.size === 0) return lines;
    return lines.filter((line) => {
      const level = line.level || detectLevel(line.text);
      return activeFilters.has(level);
    });
  }, [lines, activeFilters]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredLines, autoScroll]);

  // Detect manual scroll — disable auto-scroll when user scrolls up
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
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }

  const [copied, setCopied] = useState(false);

  function copyToClipboard() {
    const text = filteredLines.map((l) => l.text).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className={cn("rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden", className)}>
      {/* Control bar */}
      {showFilters && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-1">
            {(["error", "warn", "info", "debug"] as const).map((level) => {
              const count = levelCounts[level];
              if (count === 0 && level !== "error") return null;
              const isActive = activeFilters.has(level);
              return (
                <button
                  key={level}
                  onClick={() => toggleFilter(level)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-zinc-700 text-zinc-100"
                      : count > 0
                        ? `${LEVEL_COLORS[level]} hover:bg-zinc-800`
                        : "text-zinc-600 hover:bg-zinc-800"
                  )}
                >
                  {LEVEL_LABELS[level]}
                  {count > 0 && (
                    <span className={cn(
                      "tabular-nums",
                      level === "error" && !isActive && "text-red-400",
                      level === "warn" && !isActive && "text-yellow-400",
                    )}>
                      {count}
                    </span>
                  )}
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
            <span className="text-xs text-zinc-500 tabular-nums">
              {activeFilters.size > 0 ? `${filteredLines.length} / ${lines.length}` : lines.length} lines
            </span>
            <button
              onClick={copyToClipboard}
              className="text-zinc-500 hover:text-zinc-300 p-0.5 transition-colors"
              title="Copy to clipboard"
            >
              {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
            </button>
          </div>
        </div>
      )}

      {/* Log output */}
      <div className="relative">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          onCopy={(e) => {
            // Intercept copy to provide clean plain text instead of HTML spans
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) return;

            // Walk selected nodes and extract the raw text from data attributes
            const range = selection.getRangeAt(0);
            const fragment = range.cloneContents();
            const lines: string[] = [];
            fragment.querySelectorAll("[data-raw]").forEach((el) => {
              lines.push((el as HTMLElement).dataset.raw || "");
            });

            if (lines.length > 0) {
              e.preventDefault();
              e.clipboardData.setData("text/plain", lines.join("\n"));
            }
          }}
          className={cn("p-4 overflow-auto font-mono text-xs leading-5 select-text", height)}
        >
          {filteredLines.length === 0 ? (
            <div className="text-zinc-500">
              {lines.length === 0 ? "No output." : "No lines match the current filter."}
            </div>
          ) : (
            filteredLines.map((line, i) => (
              <div
                key={i}
                data-raw={line.text}
                className="text-zinc-300 hover:bg-white/5 px-1 -mx-1 rounded"
                dangerouslySetInnerHTML={{ __html: line.html }}
              />
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
  const lines = useMemo(() => {
    return log.split("\n").filter(Boolean).map((text) => ({
      text,
      html: highlightLogLine(text),
      level: detectLevel(text),
    }));
  }, [log]);

  return (
    <div className="border-t">
      <TerminalOutput lines={lines} height={maxHeight} showFilters={lines.length > 10} />
    </div>
  );
}

// --- Streaming log viewer ---

type LogSource = "loki" | "docker" | null;

type LogViewerProps = {
  streamUrl: string;
  historyUrl?: string;
  maxLines?: number;
};

export function LogViewer({ streamUrl, historyUrl, maxLines = 1000 }: LogViewerProps) {
  const [lines, setLines] = useState<{ text: string; html: string; level: LogLevel }[]>([]);
  const [connected, setConnected] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [paused, setPaused] = useState(false);
  const [manualReconnect, setManualReconnect] = useState(0);
  const [logSource, setLogSource] = useState<LogSource>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const visKey = useVisibilityKey();

  useEffect(() => {
    // Don't connect if tab is hidden
    if (typeof document !== "undefined" && document.hidden) return;

    setLogSource(null);

    // The SSE stream now backfills history automatically when Loki is available,
    // but if a separate historyUrl is provided, pre-load from it for instant content
    if (historyUrl) {
      fetch(historyUrl)
        .then((res) => res.json())
        .then((data: { logs?: string }) => {
          if (!data.logs) return;
          const initial = data.logs
            .split("\n")
            .filter(Boolean)
            .map((text: string) => ({
              text,
              html: highlightLine(text),
              level: detectLevel(text),
            }));
          if (initial.length > 0) {
            setLines(initial.slice(-maxLines));
          }
        })
        .catch(() => {
          // History unavailable — stream will provide content
        });
    }

    const es = new EventSource(streamUrl);

    es.onopen = () => setConnected(true);

    es.addEventListener("source", (event: MessageEvent) => {
      try {
        const src = JSON.parse(event.data) as string;
        if (src === "loki" || src === "docker") {
          setLogSource(src);
        }
      } catch {
        // skip malformed source event
      }
    });

    function handleLogEvent(event: MessageEvent) {
      if (pausedRef.current) return;
      try {
        const text = JSON.parse(event.data) as string;
        const html = highlightLine(text);
        const level = detectLevel(text);
        setLines((prev) => {
          const next = [...prev, { text, html, level }];
          if (next.length > maxLines) return next.slice(-maxLines);
          return next;
        });
      } catch {
        // Skip malformed messages
      }
    }

    // Listen for both named "log" events and unnamed events
    es.addEventListener("log", handleLogEvent);
    es.onmessage = handleLogEvent;

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
      es.removeEventListener("log", handleLogEvent);
      es.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, historyUrl, maxLines, visKey, manualReconnect]);

  return (
    <div className="space-y-2">
      {/* Stream toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${connected ? "bg-status-success" : timedOut ? "bg-status-warning" : "bg-status-error"}`} />
          <span className="text-xs text-muted-foreground">
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
        <TerminalOutput lines={lines} height="h-[500px]" />
      )}
    </div>
  );
}
