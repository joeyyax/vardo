import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Host-wide prune guard
//
// /admin once had a "Docker Cleanup" button that ran
// `docker system prune -f --volumes`. That takes stopped containers, and the
// stopped containers on this host are the standby blue/green slots that
// stopStandbySlot leaves behind for instant rollback. Reclaiming build cache
// is the Build Cache card at /admin/settings/maintenance, which goes through
// the Engine API and touches neither containers nor volumes.
//
// These tests fail if a prune that can remove containers or volumes host-wide
// comes back into the product code. App-scoped teardown (`compose down
// --volumes` against one project) is a different operation and is not covered.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "components", "scripts", "templates"];
const SCAN_EXTS = [".ts", ".tsx", ".js", ".mjs", ".sh", ".yaml", ".yml"];

/** CLI, argv and Engine API forms that can remove a container or a volume. */
const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /docker\s+system\s+prune/, label: "docker system prune" },
  { pattern: /docker\s+container\s+prune/, label: "docker container prune" },
  { pattern: /docker\s+volume\s+prune/, label: "docker volume prune" },
  { pattern: /["']system["']\s*,\s*["']prune["']/, label: "argv ['system', 'prune']" },
  { pattern: /["']container["']\s*,\s*["']prune["']/, label: "argv ['container', 'prune']" },
  { pattern: /["']volume["']\s*,\s*["']prune["']/, label: "argv ['volume', 'prune']" },
  { pattern: /["'`]\/containers\/prune/, label: "POST /containers/prune" },
  { pattern: /["'`]\/volumes\/prune/, label: "POST /volumes/prune" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (SCAN_EXTS.some((ext) => entry.endsWith(ext))) {
      out.push(path);
    }
  }
  return out;
}

/** Drops comments so prose about prunes doesn't trip the scan. */
function stripComments(path: string, source: string): string {
  const hash = path.endsWith(".sh") || path.endsWith(".yaml") || path.endsWith(".yml");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (hash ? line.replace(/#.*$/, "") : line.replace(/\/\/.*$/, "")))
    .join("\n");
}

const FILES = SCAN_DIRS.filter((d) => existsSync(join(ROOT, d))).flatMap((d) =>
  sourceFiles(join(ROOT, d)),
);

describe("no host-wide prune reaches containers or volumes", () => {
  it("scans a plausible number of files", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  for (const { pattern, label } of FORBIDDEN) {
    it(`has no call site for ${label}`, () => {
      const hits = FILES.filter((f) => pattern.test(stripComments(f, readFileSync(f, "utf-8"))));
      expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
    });
  }
});

describe("the admin Docker prune endpoint is gone", () => {
  it("has no /api/v1/admin/docker-prune route", () => {
    expect(existsSync(join(ROOT, "app/api/v1/admin/docker-prune"))).toBe(false);
  });

  it("has nothing fetching it", () => {
    const hits = FILES.filter((f) => readFileSync(f, "utf-8").includes("admin/docker-prune"));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reclamation that stayed: build cache, via the Engine API.
// ---------------------------------------------------------------------------

describe("build cache reclamation is the admin path to free disk", () => {
  const route = readFileSync(
    join(ROOT, "app/api/v1/admin/maintenance/build-cache/route.ts"),
    "utf-8",
  );

  it("goes through pruneBuildCache rather than the CLI", () => {
    expect(route).toContain("pruneBuildCache");
    expect(route).not.toContain("child_process");
  });
});
