// Vardo's stored env format. One var per line, except a double-quoted value may span lines:
//
//   KEY="-----BEGIN PRIVATE KEY-----
//   abc
//   -----END PRIVATE KEY-----"
//
// Inside a multi-line value `\\` is a backslash, `\"` a quote and `\` before a newline is dropped.
// A quoted value closed on its own line keeps today's meaning: outer quotes stripped, nothing decoded.

export type EnvKeyMode = "strict" | "loose";

export type EnvSegment =
  | { kind: "text"; raw: string }
  | { kind: "var"; key: string; value: string; raw: string; multiline: boolean };

const STRICT_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Index of the first `"` not preceded by a backslash escape, or -1. */
function unescapedQuote(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

function decodeBlock(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\" && (next === "\\" || next === '"' || next === "\n")) {
      if (next !== "\n") out += next;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The value of a line's right-hand side: today's single-line reading. */
function singleLineValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Reads a multi-line value opened on `lines[start]`; null when `value` isn't one or never closes. */
function readBlock(lines: string[], start: number, value: string): { value: string; end: number } | null {
  if (!value.startsWith('"') || value.endsWith('"')) return null;
  const rest = value.slice(1);
  if (unescapedQuote(rest) !== -1) return null;

  let inner = rest;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    const q = unescapedQuote(line);
    if (q === -1) {
      inner += `\n${line}`;
      continue;
    }
    if (line.slice(q + 1).trim() !== "") return null;
    inner += `\n${line.slice(0, q)}`;
    return { value: decodeBlock(inner), end: j };
  }
  return null;
}

/** Splits env content into variables and the lines around them. `loose` accepts any key, as the deploy path does. */
export function scanEnv(content: string, mode: EnvKeyMode = "strict"): EnvSegment[] {
  const lines = content.split("\n");
  const segments: EnvSegment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    let key: string | null = null;
    let value = "";
    if (line !== "" && !line.startsWith("#")) {
      if (mode === "strict") {
        const match = line.match(STRICT_LINE);
        if (match) [, key, value] = match;
      } else {
        const eq = line.indexOf("=");
        if (eq > 0) {
          key = line.slice(0, eq).trim();
          value = line.slice(eq + 1);
        }
      }
    }

    if (key === null) {
      segments.push({ kind: "text", raw: rawLine });
      continue;
    }

    const block = readBlock(lines, i, value);
    if (block) {
      segments.push({ kind: "var", key, value: block.value, raw: lines.slice(i, block.end + 1).join("\n"), multiline: true });
      i = block.end;
    } else {
      segments.push({ kind: "var", key, value: singleLineValue(value), raw: rawLine, multiline: false });
    }
  }

  return segments;
}

export interface ParsedEnvVar {
  key: string;
  value: string;
}

/** Variables in order, duplicates kept. */
export function parseEnvVars(content: string, mode: EnvKeyMode = "strict"): ParsedEnvVar[] {
  const vars: ParsedEnvVar[] = [];
  for (const s of scanEnv(content, mode)) if (s.kind === "var") vars.push({ key: s.key, value: s.value });
  return vars;
}

/** One `KEY=value` entry. Plain values stay on one line; anything the line format can't hold becomes a quoted block. */
export function formatEnvVar(key: string, value: string): string {
  const strippedOnRead = (value.startsWith("'") && value.endsWith("'")) || value.startsWith('"');
  const plain = !/[\r\n]/.test(value) && value === value.trimEnd() && !strippedOnRead;
  if (plain) return `${key}=${value}`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${key}="\\\n${escaped}"`;
}

/** Entries joined as env content. */
export function formatEnvContent(vars: ParsedEnvVar[]): string {
  return vars.map((v) => formatEnvVar(v.key, v.value)).join("\n");
}
