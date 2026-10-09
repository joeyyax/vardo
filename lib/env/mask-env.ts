import { scanEnv } from "./dotenv";

const MASKED = "••••••••";

function maskLine(line: string): string {
  if (line.startsWith("#") || !line.includes("=")) return line;
  return `${line.slice(0, line.indexOf("="))}=${MASKED}`;
}

/** Env content with every value hidden; a multi-line value collapses to one line. */
export function maskEnvContent(content: string): string {
  return scanEnv(content, "loose")
    .map((segment) => (segment.kind === "var" && segment.multiline ? `${segment.key}=${MASKED}` : maskLine(segment.raw)))
    .join("\n");
}

/** Puts stored values back where `content` still holds the mask; a masked key with no stored value is dropped. */
export function restoreMaskedEnv(content: string, stored: string): string {
  const raws = new Map<string, string[]>();
  for (const s of scanEnv(stored, "loose")) {
    if (s.kind === "var") raws.set(s.key, [...(raws.get(s.key) ?? []), s.raw]);
  }
  const out: string[] = [];
  for (const s of scanEnv(content, "loose")) {
    if (s.kind !== "var" || s.value !== MASKED) {
      out.push(s.raw);
      continue;
    }
    const queue = raws.get(s.key);
    const raw = queue && (queue.length > 1 ? queue.shift() : queue[0]);
    if (raw !== undefined) out.push(raw);
  }
  return out.join("\n");
}
