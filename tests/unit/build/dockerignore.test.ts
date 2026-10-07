import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

function parse(text: string): { negate: boolean; re: RegExp }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      const glob = path.posix.normalize((negate ? line.slice(1) : line).replace(/^\/+/, ""));
      let re = "";
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
          i++;
          if (glob[i + 1] === "/") {
            i++;
            re += "(?:.*/)?";
          } else re += ".*";
        } else if (c === "*") re += "[^/]*";
        else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      return { negate, re: new RegExp(`^${re}$`) };
    });
}

// Docker matches patterns against the path from the context root, and a match on a directory ignores everything under it.
function isIgnored(file: string, rules: ReturnType<typeof parse>): boolean {
  const parts = file.split("/");
  let ignored = false;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    for (const { negate, re } of rules) {
      if (re.test(candidate)) ignored = !negate;
    }
    if (ignored) return true;
  }
  return false;
}

describe(".dockerignore", () => {
  const rules = parse(readFileSync(path.join(root, ".dockerignore"), "utf8"));

  it("matches the way Docker does", () => {
    const sample = parse("out\n**/node_modules\n*.md\n!keep.md");
    expect(isIgnored("out/a.js", sample)).toBe(true);
    expect(isIgnored("app/out/page.tsx", sample)).toBe(false);
    expect(isIgnored("a/b/node_modules/x", sample)).toBe(true);
    expect(isIgnored("README.md", sample)).toBe(true);
    expect(isIgnored("keep.md", sample)).toBe(false);
    expect(isIgnored("docs/README.md", sample)).toBe(false);
  });

  it("keeps every tracked file under app/ in the image", () => {
    const files = execFileSync("git", ["ls-files", "app"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => isIgnored(f, rules))).toEqual([]);
  });
});
