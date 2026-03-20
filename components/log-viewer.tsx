"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";

type LogLine = {
  id: number;
  text: string;
  html: string;
};

type LogViewerProps = {
  streamUrl: string;
  maxLines?: number;
};

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
  [/\b([2]\d{2})\b/g, "text-green-400"],
  [/\b([3]\d{2})\b/g, "text-blue-400"],
  [/\b([4]\d{2})\b/g, "text-yellow-400"],
  [/\b([5]\d{2})\b/g, "text-red-400"],
  // URLs and paths
  [/https?:\/\/[^\s"']+/g, "text-blue-300 underline"],
  [/\/[a-zA-Z0-9\-._~/]+/g, "text-zinc-400"],
  // Quoted strings
  [/"[^"]*"/g, "text-amber-300"],
  // Numbers (standalone)
  [/\b\d+(\.\d+)?(ms|s|m|MB|KB|GB|B)?\b/g, "text-purple-300"],
  // Docker/deploy markers
  [/\[deploy\]/g, "text-cyan-400 font-medium"],
  [/\[docker\]/g, "text-blue-400 font-medium"],
  [/\[health\]/g, "text-green-400 font-medium"],
  [/\[build\]/g, "text-amber-400 font-medium"],
  [/\[nixpacks\]/g, "text-violet-400 font-medium"],
  [/\[error\]/g, "text-red-400 font-medium"],
];

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
  // We use a placeholder approach to avoid double-matching
  const replacements: { start: number; end: number; replacement: string }[] = [];

  for (const [pattern, className] of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(html)) !== null) {
      // Skip if this range overlaps with an existing replacement
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

  // Apply replacements in reverse order to preserve indices
  replacements.sort((a, b) => b.start - a.start);
  for (const { start, end, replacement } of replacements) {
    html = html.slice(0, start) + replacement + html.slice(end);
  }

  return html;
}

export function LogViewer({ streamUrl, maxLines = 1000 }: LogViewerProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(streamUrl);
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (event) => {
      if (paused) return;
      try {
        const text = JSON.parse(event.data) as string;
        const id = ++idRef.current;
        const html = highlightLine(text);
        setLines((prev) => {
          const next = [...prev, { id, text, html }];
          if (next.length > maxLines) return next.slice(-maxLines);
          return next;
        });
      } catch {
        // Skip malformed messages
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [streamUrl, paused, maxLines]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  // Detect manual scroll
  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(atBottom);
  }

  return (
    <div className="space-y-2">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-xs text-muted-foreground">
            {connected ? "Streaming" : "Disconnected"}
          </span>
          <span className="text-xs text-muted-foreground">
            {lines.length} lines
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPaused(!paused)}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </Button>
          {!autoScroll && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAutoScroll(true);
                if (containerRef.current) {
                  containerRef.current.scrollTop = containerRef.current.scrollHeight;
                }
              }}
              title="Scroll to bottom"
            >
              <ArrowDown className="size-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setLines([])}
            title="Clear"
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Log output */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="rounded-lg border bg-black/80 p-4 h-[500px] overflow-auto font-mono text-xs leading-5"
      >
        {lines.length === 0 ? (
          <div className="flex items-center gap-2 text-zinc-500">
            {connected ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Waiting for output...
              </>
            ) : (
              "No logs available. Is the project running?"
            )}
          </div>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              className="text-zinc-300 hover:bg-white/5 px-1 -mx-1 rounded"
              dangerouslySetInnerHTML={{ __html: line.html }}
            />
          ))
        )}
      </div>
    </div>
  );
}
