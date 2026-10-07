import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "../../..");
const DIRS = ["app", "components"];

// "path:phrase" entries that are correct as written.
const ALLOW = new Set<string>([
  "app/(authenticated)/projects/first-run.tsx:compose file or buildpack, and redeploy",
]);

type Hit = { file: string; line: number; text: string };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function codeLines(file: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inBlock = false;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      const t = raw.trim();
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        return;
      }
      if (t.startsWith("/*") || t.startsWith("{/*")) {
        if (!t.includes("*/")) inBlock = true;
        return;
      }
      if (t.startsWith("//") || t.startsWith("*")) return;
      if (/\b(console|log|logger)\.\w+\(/.test(t) || t.startsWith("import ")) return;
      out.push({ line: i + 1, text: raw });
    });
  return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d))).filter(
  (f) => !f.includes("api/v1/github/webhook"),
);

function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    for (const { line, text } of codeLines(file)) {
      const m = text.match(pattern);
      if (!m) continue;
      if ([...ALLOW].some((a) => a.startsWith(`${rel}:`) && text.includes(a.slice(rel.length + 1)))) continue;
      hits.push({ file: rel, line, text: text.trim() });
    }
  }
  return hits;
}

const fmt = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n");

describe("UI copy style guard", () => {
  it('uses "Couldn\'t" instead of "Failed to" in messages', () => {
    expect(fmt(scan(/["'`]Failed to /))).toBe("");
  });

  it('doesn\'t say "Please"', () => {
    expect(fmt(scan(/(["'`>]|\s)Please\b/))).toBe("");
  });

  it("doesn't end toasts with an exclamation mark", () => {
    expect(fmt(scan(/toast(\.\w+)?\(\s*["'`][^"'`]*!["'`]/))).toBe("");
  });

  it("doesn't use the Oxford comma", () => {
    expect(fmt(scan(/[A-Za-z0-9)], [^,."'`<>{}()=]{1,40}, (and|or) [a-z]/))).toBe("");
  });
});
