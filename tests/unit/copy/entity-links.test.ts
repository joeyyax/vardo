import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Source guard: entity names render as real links, and nothing navigates without an href.

const ROOT = process.cwd();
const DIRS = ["app", "components"];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

const files = DIRS.flatMap((d) => tsxFiles(join(ROOT, d))).map((path) => ({
  path: relative(ROOT, path),
  source: readFileSync(path, "utf8"),
}));

/** Each JSX opening of a component, up to its closing `>` or `/>`, with the file it's in. */
function usages(component: string) {
  const out: { path: string; props: string }[] = [];
  const open = new RegExp(`<${component}\\b`, "g");
  for (const { path, source } of files) {
    for (const match of source.matchAll(open)) {
      let depth = 0;
      let end = match.index!;
      for (let i = match.index! + 1; i < source.length; i++) {
        const c = source[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) {
          end = i;
          break;
        }
      }
      out.push({ path, props: source.slice(match.index!, end) });
    }
  }
  return out;
}

describe("entity names are links", () => {
  // Rows open a drawer, but the name in them goes to the page.
  for (const component of ["ListRow", "SectionHeader", "IssueItem"]) {
    it(`${component} is always given an href`, () => {
      const found = usages(component);
      expect(found.length, `no ${component} usages found`).toBeGreaterThan(0);
      for (const u of found) expect(u.props, `${u.path}: <${component}> without href`).toMatch(/\shref=/);
    });
  }
});

describe("tab rails are links", () => {
  it("SectionNav is always given hrefFor", () => {
    const found = usages("SectionNav");
    expect(found.length).toBeGreaterThan(0);
    for (const u of found) expect(u.props, `${u.path}: <SectionNav> without hrefFor`).toMatch(/\shrefFor=/);
  });
});

describe("navigation has an href", () => {
  it("never navigates from an onClick or onSelect alone", () => {
    const offenders = files.filter(({ source }) => /on(Click|Select)=\{\(\) => router\.push\(/.test(source)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  // A div posing as a button ends up holding links and buttons. Use a real button beside them.
  it("has no role=button stand-ins", () => {
    const offenders = files.filter(({ source }) => /role="button"/.test(source)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
