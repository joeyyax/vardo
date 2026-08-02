// ---------------------------------------------------------------------------
// Log syntax highlighting.
//
// Uses bright terminal-native colors (not design system tokens) because the
// log viewer always renders on a zinc-950 background regardless of theme.
// ---------------------------------------------------------------------------

import { findRanges } from "./search";

const PATTERNS: [RegExp, string][] = [
  // Deploy stage markers — compound tags first to prevent partial matches
  [/\[deploy\]\[compose\]/g, "text-cyan-400 font-medium"],
  [/\[build\]\[nixpacks\]/g, "text-amber-400 font-medium"],
  [/\[build\]\[docker\]/g, "text-amber-400 font-medium"],
  // Single markers
  [/\[deploy\]/g, "text-cyan-400 font-medium"],
  [/\[docker\]/g, "text-cyan-300 font-medium"],
  [/\[health\]/g, "text-green-400 font-medium"],
  [/\[build\]/g, "text-amber-400 font-medium"],
  [/\[nixpacks\]/g, "text-violet-400 font-medium"],
  [/\[compat\]/g, "text-yellow-400 font-medium"],
  [/\[error\]/g, "text-red-400 font-medium"],
  // Timestamps: ISO, common log formats
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "text-zinc-500"],
  // Error levels
  [/\b(ERROR|FATAL|PANIC|CRIT(ICAL)?)\b/gi, "text-red-400 font-semibold"],
  [/\b(WARN(ING)?)\b/gi, "text-yellow-400"],
  [/\b(INFO|NOTICE)\b/gi, "text-blue-400"],
  [/\b(DEBUG|TRACE)\b/gi, "text-zinc-500"],
  // HTTP methods
  [/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g, "text-cyan-400 font-medium"],
  // HTTP status codes
  [/\b([2]\d{2})\b/g, "text-green-400"],
  [/\b([3]\d{2})\b/g, "text-blue-400"],
  [/\b([4]\d{2})\b/g, "text-yellow-400"],
  [/\b([5]\d{2})\b/g, "text-red-400"],
  // Arrow operators (volume mappings, etc.)
  [/→/g, "text-zinc-500"],
  // Key: Value pairs in deploy output (e.g. "Environment: production")
  [/\b(Environment|App|Source|Type|Active slot):/g, "text-zinc-500"],
  // URLs
  [/https?:\/\/[^\s"']+/g, "text-blue-400 underline"],
  // Quoted strings
  [/"[^"]*"/g, "text-amber-300/80"],
  // Numbers with units
  [/\b\d+(\.\d+)?(ms|s|m|MB|KB|GB|B)?\b/g, "text-purple-300/80"],
];

const MATCH_CLASS = "bg-amber-400/25 text-amber-100 rounded-[2px]";
const ACTIVE_MATCH_CLASS = "bg-amber-400 text-zinc-950 rounded-[2px]";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SERVICE_COLORS = [
  "text-cyan-400/70",
  "text-violet-400/70",
  "text-emerald-400/70",
  "text-amber-400/70",
  "text-pink-400/70",
  "text-sky-400/70",
];

/** Stable color per service so the all-services view stays scannable. */
export function serviceColor(service: string): string {
  let hash = 0;
  for (let i = 0; i < service.length; i++) hash = (hash * 31 + service.charCodeAt(i)) >>> 0;
  return SERVICE_COLORS[hash % SERVICE_COLORS.length];
}

/**
 * Render a line as HTML. When `query` is set its occurrences are marked, and
 * the `activeOrdinal`-th one on this line is marked as the current match.
 */
export function highlightLine(text: string, query = "", activeOrdinal = -1): string {
  let html = escapeHtml(text);
  const replacements: { start: number; end: number; replacement: string }[] = [];

  // Search marks claim their span first so syntax colors never split them.
  findRanges(html, escapeHtml(query)).forEach((range, ordinal) => {
    const className = ordinal === activeOrdinal ? ACTIVE_MATCH_CLASS : MATCH_CLASS;
    replacements.push({
      ...range,
      replacement: `<mark class="${className}">${html.slice(range.start, range.end)}</mark>`,
    });
  });

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
