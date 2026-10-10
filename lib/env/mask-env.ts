import { scanEnv, type EnvSegment } from "./dotenv";
import { redactSecrets } from "@/lib/redact";

const MASKED = "••••••••";

// `# KEY=value`: a variable switched off by commenting it out.
const COMMENTED_VAR = /^(\s*#\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

/** What a segment shows when values are hidden. */
function maskSegment(segment: EnvSegment): string {
  if (segment.kind === "var") return `${segment.key}=${MASKED}`;
  const line = segment.raw;
  const trimmed = line.trim();
  if (trimmed === "") return line;
  if (trimmed.startsWith("#")) {
    const commented = COMMENTED_VAR.exec(line);
    if (commented) return `${commented[1]}${commented[2]}=${MASKED}`;
    return redactSecrets(line) === line ? line : `# ${MASKED}`;
  }
  // A line the scanner couldn't place, such as the rest of an unclosed multi-line value.
  return MASKED;
}

/** Env content with every value hidden, commented-out ones included; a multi-line value collapses to one line. */
export function maskEnvContent(content: string): string {
  return scanEnv(content, "loose").map(maskSegment).join("\n");
}

/** Puts stored values back where `content` still holds the mask; a masked line with no stored value is dropped. */
export function restoreMaskedEnv(content: string, stored: string): string {
  const raws = new Map<string, string[]>();
  const lines = new Map<string, string[]>();
  for (const s of scanEnv(stored, "loose")) {
    if (s.kind === "var") {
      raws.set(s.key, [...(raws.get(s.key) ?? []), s.raw]);
      continue;
    }
    const masked = maskSegment(s);
    if (masked !== s.raw) lines.set(masked, [...(lines.get(masked) ?? []), s.raw]);
  }
  const out: string[] = [];
  for (const s of scanEnv(content, "loose")) {
    if (s.kind === "var" && s.value === MASKED) {
      const queue = raws.get(s.key);
      const raw = queue && (queue.length > 1 ? queue.shift() : queue[0]);
      if (raw !== undefined) out.push(raw);
      continue;
    }
    if (s.kind === "text" && s.raw.includes(MASKED)) {
      const raw = lines.get(s.raw)?.shift();
      if (raw !== undefined) out.push(raw);
      continue;
    }
    out.push(s.raw);
  }
  return out.join("\n");
}
