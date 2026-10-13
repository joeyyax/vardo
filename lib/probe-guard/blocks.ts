// Owner-written turn-away entries, rendered into the same PathRegexp as the managed rules.

import { PATH_RE, type ProbeRule } from "./rules";

export const BLOCK_KINDS = ["prefix", "exact", "regex"] as const;

export type CustomBlock = {
  kind: (typeof BLOCK_KINDS)[number];
  value: string;
  note?: string;
  /** The template that added it, so removing the template removes it. */
  template?: string;
};

export const MAX_BLOCK_LENGTH = 500;
export const MAX_NOTE_LENGTH = 200;
const MAX_REPEAT = 1000;

const ESCAPE_RE = /[\\^$.|?*+()[\]{}]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// Letter escapes RE2 and JS read the same way.
const SAFE_LETTER_ESCAPES = "bBdDsSwWfnrtv";

/** The anchored pattern a block contributes to the path regexp. */
export function blockPattern(block: CustomBlock): string {
  if (block.kind === "regex") return block.value;
  const escaped = block.value.replace(ESCAPE_RE, "\\$&");
  return block.kind === "prefix" ? `^${escaped}` : `^${escaped}$`;
}

/** The first reason a regex uses syntax Go's RE2 doesn't take, or null. Traefik compiles entries with RE2; JS accepts more. */
function re2Problem(value: string): string | null {
  let i = 0;
  let afterRepeat = false;
  while (i < value.length) {
    const c = value[i];
    if (c === "\\") {
      const next = value[i + 1];
      if (next === undefined) return "ends with a lone backslash";
      if (/[0-9]/.test(next)) return "backreferences and octal escapes aren't supported";
      if (next === "x") {
        if (!/^[0-9A-Fa-f]{2}/.test(value.slice(i + 2))) return "\\x takes exactly two hex digits";
        i += 4;
        afterRepeat = false;
        continue;
      }
      if (/[A-Za-z]/.test(next) && !SAFE_LETTER_ESCAPES.includes(next)) return `\\${next} isn't supported`;
      i += 2;
      afterRepeat = false;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (value[j] === "^") j += 1;
      if (value[j] === "]") return "empty character class";
      let closed = false;
      while (j < value.length) {
        if (value[j] === "\\") {
          j += 2;
          continue;
        }
        if (value[j] === "]") {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return "unclosed character class";
      i = j + 1;
      afterRepeat = false;
      continue;
    }
    if (c === "(") {
      if (value[i + 1] === "?" && value[i + 2] !== ":") return "only (?: groups are supported";
      i += value[i + 1] === "?" ? 3 : 1;
      afterRepeat = false;
      continue;
    }
    const counted = c === "{" ? /^\{(\d+)(?:,(\d*))?\}/.exec(value.slice(i)) : null;
    if (c === "*" || c === "+" || c === "?" || counted) {
      if (afterRepeat) return "repeats can't be nested";
      if (counted) {
        const high = Math.max(Number(counted[1]), counted[2] ? Number(counted[2]) : 0);
        if (high > MAX_REPEAT) return `repeat counts are limited to ${MAX_REPEAT}`;
      }
      i += counted ? counted[0].length : 1;
      if (value[i] === "?") i += 1;
      afterRepeat = true;
      continue;
    }
    i += 1;
    afterRepeat = false;
  }
  return null;
}

/** Why a block is refused, or null. */
export function blockProblem(block: CustomBlock): string | null {
  const { kind, value } = block;
  if (!BLOCK_KINDS.includes(kind)) return `"${kind}" isn't a kind of entry`;
  if (value.length === 0) return "Enter a path or pattern";
  if (value.length > MAX_BLOCK_LENGTH) return `Entries are limited to ${MAX_BLOCK_LENGTH} characters`;
  if (block.note && block.note.length > MAX_NOTE_LENGTH) return `Notes are limited to ${MAX_NOTE_LENGTH} characters`;
  if (kind !== "regex") {
    if (!value.startsWith("/")) return `"${value.slice(0, 60)}" must start with /`;
    if (!PATH_RE.test(value)) return `"${value.slice(0, 60)}" has characters a path can't`;
    if (value === "/") return "A block on / would turn away the whole site";
    return null;
  }
  if (value.includes("`")) return "Backticks aren't allowed";
  if (CONTROL_RE.test(value)) return "Control characters aren't allowed";
  const unsupported = re2Problem(value);
  if (unsupported) return `"${value.slice(0, 60)}": ${unsupported}`;
  let re: RegExp;
  try {
    re = new RegExp(value, "i");
  } catch {
    return `"${value.slice(0, 60)}" isn't a valid pattern`;
  }
  if (re.test("/") || re.test("")) return "That pattern matches the home page";
  return null;
}

/** One case-insensitive PathRegexp alternation over the rules and blocks, or null when there is nothing to match. An empty alternation would match every path. */
export function probePathRegexp(rules: readonly ProbeRule[], blocks: readonly CustomBlock[] = []): string | null {
  const patterns = [...rules.map((r) => r.pattern), ...blocks.map(blockPattern)];
  if (patterns.length === 0) return null;
  return `(?i)${patterns.map((p) => `(?:${p})`).join("|")}`;
}

/** Whether the path trips one of the blocks, as the rendered regexp reads it. */
export function matchBlock(path: string, blocks: readonly CustomBlock[]): CustomBlock | null {
  return blocks.find((b) => new RegExp(blockPattern(b), "i").test(path)) ?? null;
}
