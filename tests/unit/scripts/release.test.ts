import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bumpVersion,
  compareSemver,
  countBreaking,
  groupCommits,
  highestTag,
  parseArgs,
  parseCommit,
  parseSemver,
  prependSection,
  renderSection,
  run,
  sectionNotes,
  setPackageVersion,
  type Deps,
} from "@/scripts/release";

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

describe("compareSemver", () => {
  it("orders numerically, not lexically", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("1.2.10", "1.2.9")).toBeGreaterThan(0);
  });

  it("ranks a prerelease below its release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("orders prerelease identifiers per the semver spec", () => {
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3-rc.1", "1.2.3-rc.1")).toBe(0);
  });

  it("throws on invalid input", () => {
    expect(() => compareSemver("1.2", "1.2.3")).toThrow();
  });
});

describe("parseSemver", () => {
  it("rejects invalid versions", () => {
    for (const v of ["1.2", "01.2.3", "1.2.3.4", "v1.2.3", "1.2.3+build", "1.2.3-", "latest", ""]) {
      expect(parseSemver(v), v).toBeNull();
    }
  });

  it("accepts prereleases", () => {
    expect(parseSemver("1.0.0-rc.1")).toEqual({ major: 1, minor: 0, patch: 0, pre: ["rc", "1"] });
  });
});

describe("highestTag", () => {
  it("picks the highest semver, ignoring non-version tags", () => {
    const tags = ["v0.9.0", "v0.10.0", "v0.2.0", "vnext", "release-1", "v1.0.0-rc.1"];
    expect(highestTag(tags)).toEqual({ tag: "v1.0.0-rc.1", version: "1.0.0-rc.1" });
    expect(highestTag(tags, { stableOnly: true })).toEqual({ tag: "v0.10.0", version: "0.10.0" });
  });

  it("returns null with no version tags", () => {
    expect(highestTag([])).toBeNull();
    expect(highestTag(["foo"])).toBeNull();
  });
});

describe("bumpVersion", () => {
  it("bumps patch, minor and major at 1.x", () => {
    expect(bumpVersion("1.4.2", "patch").version).toBe("1.4.3");
    expect(bumpVersion("1.4.2", "minor").version).toBe("1.5.0");
    expect(bumpVersion("1.4.2", "major").version).toBe("2.0.0");
  });

  it("bumps minor instead of major under 0.x and says so", () => {
    const r = bumpVersion("0.4.2", "major", { breaking: 1 });
    expect(r.version).toBe("0.5.0");
    expect(r.notes.join(" ")).toMatch(/0\.x/);
  });

  it("keeps patch and minor behavior under 0.x", () => {
    expect(bumpVersion("0.4.2", "patch").version).toBe("0.4.3");
    expect(bumpVersion("0.4.2", "minor").version).toBe("0.5.0");
  });

  it("warns when a patch bump hides breaking changes", () => {
    const r = bumpVersion("1.0.0", "patch", { breaking: 2 });
    expect(r.version).toBe("1.0.1");
    expect(r.notes.join(" ")).toMatch(/2 breaking changes/);
  });

  it("finalizes a prerelease instead of skipping past it", () => {
    expect(bumpVersion("1.0.0-rc.2", "patch").version).toBe("1.0.0");
    expect(bumpVersion("1.0.0-rc.2", "minor").version).toBe("1.0.0");
    expect(bumpVersion("1.0.0-rc.2", "major").version).toBe("1.0.0");
    expect(bumpVersion("1.2.0-rc.1", "major").version).toBe("2.0.0");
    expect(bumpVersion("1.2.3-rc.1", "minor").version).toBe("1.3.0");
  });
});

describe("parseArgs", () => {
  it("accepts keywords, versions and --publish", () => {
    expect(parseArgs(["minor"])).toEqual({ spec: "minor", publish: false });
    expect(parseArgs(["v1.0.0-rc.1", "--publish"])).toEqual({ spec: "1.0.0-rc.1", publish: true });
  });

  it("rejects bad input", () => {
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["banana"])).toHaveProperty("error");
    expect(parseArgs(["patch", "--force"])).toHaveProperty("error");
    expect(parseArgs(["patch", "minor"])).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

describe("parseCommit", () => {
  it("parses a scoped squash-merge title", () => {
    const c = parseCommit("feat(deploy): Postgres deploy queue schema and library (#979)");
    expect(c).toMatchObject({
      type: "feat",
      scope: "deploy",
      description: "Postgres deploy queue schema and library",
      ref: "979",
      breaking: false,
      noise: false,
    });
  });

  it("parses an unscoped title and keeps inner parentheses", () => {
    const c = parseCommit(
      "fix: cleanup round 1 (cert copy, kit footer, update-skipped email, backup run deadline) (#972)",
    );
    expect(c.type).toBe("fix");
    expect(c.scope).toBeNull();
    expect(c.ref).toBe("972");
    expect(c.description).toBe(
      "cleanup round 1 (cert copy, kit footer, update-skipped email, backup run deadline)",
    );
  });

  it("handles a title without a reference", () => {
    const c = parseCommit("feat(digest): one org digest per person");
    expect(c.ref).toBeNull();
    expect(c.description).toBe("one org digest per person");
  });

  it("flags breaking changes by bang and by footer", () => {
    expect(parseCommit("feat(api)!: drop v0 routes (#1)").breaking).toBe(true);
    expect(parseCommit("feat!: drop v0 routes").breaking).toBe(true);
    expect(parseCommit("fix: rename flag", "Body.\n\nBREAKING CHANGE: flag renamed").breaking).toBe(true);
    expect(parseCommit("fix: rename flag", "BREAKING-CHANGE: flag renamed").breaking).toBe(true);
    expect(parseCommit("fix: mention BREAKING CHANGE: in prose only").breaking).toBe(false);
  });

  it("marks merges and reverts as noise", () => {
    expect(parseCommit("Merge pull request #971 from joeyyax/feat/org-digest").noise).toBe(true);
    expect(parseCommit('Revert "feat: thing"').noise).toBe(true);
    expect(parseCommit("revert: feat thing (#5)").noise).toBe(true);
  });

  it("leaves unparseable subjects raw", () => {
    const c = parseCommit("Say why an app is quiet, and since when (#795)");
    expect(c.type).toBeNull();
    expect(c.raw).toBe("Say why an app is quiet, and since when (#795)");
    expect(c.ref).toBe("795");
  });
});

describe("groupCommits", () => {
  const commits = [
    "feat(deploy): queue (#1)",
    "fix: race (#2)",
    "perf(db): index (#3)",
    "docs: license (#4)",
    "refactor(x): move (#5)",
    "build: docker (#6)",
    "ci: cache (#7)",
    "chore: deps (#8)",
    "test: add (#9)",
    "style: format (#10)",
    "Merge pull request #11 from a/b",
    "Say hello (#12)",
  ].map((s) => parseCommit(s));

  it("groups by type in the stated buckets", () => {
    const g = groupCommits(commits);
    expect(g.Features.map((e) => e.text)).toEqual(["**deploy:** queue (#1)"]);
    expect(g.Fixes.map((e) => e.text)).toEqual(["race (#2)"]);
    expect(g.Performance.map((e) => e.text)).toEqual(["**db:** index (#3)"]);
    expect(g.Other.map((e) => e.text)).toEqual([
      "license (#4)",
      "**x:** move (#5)",
      "docker (#6)",
      "cache (#7)",
      "Say hello (#12)",
    ]);
  });

  it("drops chore, test, style and merge noise", () => {
    const all = Object.values(groupCommits(commits)).flat().map((e) => e.text).join("\n");
    for (const dropped of ["deps", "add", "format", "Merge"]) {
      expect(all).not.toContain(dropped);
    }
  });

  it("keeps a breaking chore visible and marked", () => {
    const g = groupCommits([parseCommit("chore!: drop node 18 (#20)")]);
    expect(g.Other).toEqual([{ text: "**BREAKING** drop node 18 (#20)", breaking: true }]);
  });

  it("counts breaking commits excluding noise", () => {
    const list = [
      parseCommit("feat!: a"),
      parseCommit("fix: b", "BREAKING CHANGE: x"),
      parseCommit("fix: c"),
    ];
    expect(countBreaking(list)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Changelog rendering
// ---------------------------------------------------------------------------

describe("renderSection and prependSection", () => {
  const groups = groupCommits([
    parseCommit("feat(a): one (#1)"),
    parseCommit("fix: two (#2)"),
  ]);

  it("renders a Keep a Changelog section", () => {
    const s = renderSection({ version: "0.2.0", date: "2026-10-14", groups });
    expect(s).toBe(
      ["## [0.2.0] - 2026-10-14", "", "### Features", "", "- **a:** one (#1)", "", "### Fixes", "", "- two (#2)", ""].join("\n"),
    );
  });

  it("labels the first release", () => {
    const s = renderSection({ version: "0.1.0", date: "2026-10-14", groups, initial: true });
    expect(s).toContain("Initial release.");
    expect(s).toContain("### Features");
  });

  it("says so when nothing is notable", () => {
    const s = renderSection({ version: "0.1.1", date: "2026-10-14", groups: groupCommits([]) });
    expect(s).toContain("No notable changes.");
  });

  it("strips the heading for release notes", () => {
    const s = renderSection({ version: "0.2.0", date: "2026-10-14", groups });
    expect(sectionNotes(s).startsWith("### Features")).toBe(true);
    expect(sectionNotes(s)).not.toContain("## [0.2.0]");
  });

  it("puts new sections under Unreleased, newest first", () => {
    const seed = "# Changelog\n\nIntro.\n\n## [Unreleased]\n";
    const one = prependSection(seed, renderSection({ version: "0.2.0", date: "2026-10-14", groups }));
    const two = prependSection(one, renderSection({ version: "0.3.0", date: "2026-11-01", groups }));
    const order = [...two.matchAll(/^## \[(.+?)\]/gm)].map((m) => m[1]);
    expect(order).toEqual(["Unreleased", "0.3.0", "0.2.0"]);
    expect(two.endsWith("\n")).toBe(true);
    expect(two).not.toMatch(/\n\n\n/);
  });

  it("inserts before the first release when Unreleased is missing", () => {
    const existing = "# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- x\n";
    const out = prependSection(existing, "## [0.2.0] - 2026-02-01\n\n- y\n");
    expect(out.indexOf("[0.2.0]")).toBeLessThan(out.indexOf("[0.1.0]"));
  });
});

describe("setPackageVersion", () => {
  it("changes only the version line", () => {
    const text = '{\n  "name": "vardo",\n  "version": "0.1.0",\n  "dependencies": {\n    "version": "^1.0.0"\n  }\n}\n';
    const out = setPackageVersion(text, "0.2.0");
    expect(out).toBe(text.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    expect(out).toContain('"version": "^1.0.0"');
  });
});

// ---------------------------------------------------------------------------
// run() against a temporary git repository
// ---------------------------------------------------------------------------

type Fixture = {
  dir: string;
  origin: string;
  root: string;
  git: (...args: string[]) => string;
  originGit: (...args: string[]) => string;
  commit: (msg: string) => void;
};

const roots: string[] = [];

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function makeRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vardo-release-test-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const dir = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  const git = (...args: string[]) => sh(dir, args);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("remote", "add", "origin", origin);
  writeFileSync(join(dir, "package.json"), '{\n  "name": "demo",\n  "version": "0.1.0"\n}\n');
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
  git("add", ".");
  git("commit", "-m", "chore: init");
  git("push", "-u", "origin", "main");
  return {
    dir,
    origin,
    root,
    git,
    originGit: (...args) => sh(origin, args),
    commit: (msg) => void git("commit", "--allow-empty", "-m", msg),
  };
}

type GhCall = string[];

function makeDeps(fx: Fixture, opts: { ghFails?: boolean } = {}) {
  const out: string[] = [];
  const ghCalls: GhCall[] = [];
  const notes: string[] = [];
  const deps: Deps = {
    cwd: fx.dir,
    log: (l) => out.push(l),
    now: () => new Date("2026-10-14T12:00:00Z"),
    exec: (cmd, args, { cwd }) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        if (args[0] === "auth") return "ok";
        if (opts.ghFails) throw new Error("HTTP 502 from gh");
        const nf = args[args.indexOf("--notes-file") + 1];
        notes.push(readFileSync(nf, "utf8"));
        return "https://example.com/release";
      }
      return sh(cwd, args);
    },
  };
  return { deps, out, ghCalls, notes, text: () => out.join("\n") };
}

function snapshot(fx: Fixture) {
  return {
    head: fx.git("rev-parse", "HEAD"),
    tags: fx.git("tag", "--list"),
    status: fx.git("status", "--porcelain"),
    branches: fx.git("branch", "--list"),
    pkg: readFileSync(join(fx.dir, "package.json"), "utf8"),
    changelog: readFileSync(join(fx.dir, "CHANGELOG.md"), "utf8"),
    originRefs: fx.originGit("for-each-ref"),
  };
}

function tagAndPush(fx: Fixture, tag: string) {
  fx.git("tag", "-a", tag, "-m", tag);
  fx.git("push", "origin", "main", tag);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("run: dry run", () => {
  it("changes nothing locally or remotely and prints the plan", () => {
    const fx = makeRepo();
    fx.commit("feat(deploy): queue (#10)");
    fx.commit("fix: race (#11)");
    fx.git("push", "origin", "main");
    const before = snapshot(fx);
    const h = makeDeps(fx);

    const code = run(["minor"], h.deps);

    expect(code).toBe(0);
    expect(snapshot(fx)).toEqual(before);
    expect(h.ghCalls).toEqual([]);
    const text = h.text();
    expect(text).toContain("Release v0.2.0");
    expect(text).toContain("## [0.2.0] - 2026-10-14");
    expect(text).toContain("- **deploy:** queue (#10)");
    expect(text).toContain("git push origin main v0.2.0");
    expect(text).toContain("gh release create v0.2.0 --title v0.2.0 --notes-file");
    expect(text).toContain("Dry run. Nothing was changed.");
  });

  it("reports what would block a publish without failing", () => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    writeFileSync(join(fx.dir, "dirty.txt"), "x");
    const h = makeDeps(fx);
    expect(run(["patch"], h.deps)).toBe(0);
    expect(h.text()).toContain("Working tree is not clean.");
    expect(h.text()).toContain("not up to date with origin/main");
  });

  it("rejects a version that is not greater than the latest tag", () => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    fx.git("push", "origin", "main");
    tagAndPush(fx, "v0.10.0");
    const h = makeDeps(fx);
    expect(run(["0.9.0"], h.deps)).toBe(1);
    expect(h.text()).toMatch(/must be greater than the latest tag v0\.10\.0/);
    expect(run(["0.10.0"], makeDeps(fx).deps)).toBe(1);
  });

  it("only counts commits since the last tag", () => {
    const fx = makeRepo();
    fx.commit("feat: old (#1)");
    fx.git("push", "origin", "main");
    tagAndPush(fx, "v0.2.0");
    fx.commit("fix: new (#2)");
    const h = makeDeps(fx);
    run(["patch"], h.deps);
    expect(h.text()).toContain("Release v0.2.1");
    expect(h.text()).toContain("- new (#2)");
    expect(h.text()).not.toContain("old (#1)");
    expect(h.text()).not.toContain("Initial release");
  });

  it("maps breaking changes under 0.x to a minor bump", () => {
    const fx = makeRepo();
    fx.commit("feat(api)!: drop v0 (#3)");
    const h = makeDeps(fx);
    run(["major"], h.deps);
    expect(h.text()).toContain("Release v0.2.0");
    expect(h.text()).toMatch(/Under 0\.x/);
    expect(h.text()).toContain("**BREAKING** **api:** drop v0 (#3)");
  });

  it("includes rc-era commits when releasing the stable version", () => {
    const fx = makeRepo();
    fx.commit("feat: before rc (#1)");
    fx.git("push", "origin", "main");
    tagAndPush(fx, "v0.2.0");
    fx.commit("feat: in rc (#2)");
    fx.git("push", "origin", "main");
    tagAndPush(fx, "v0.3.0-rc.1");
    fx.commit("fix: after rc (#3)");
    const h = makeDeps(fx);
    run(["0.3.0"], h.deps);
    expect(h.text()).toContain("in rc (#2)");
    expect(h.text()).toContain("after rc (#3)");
    expect(h.text()).not.toContain("before rc (#1)");
  });
});

describe("run: publish", () => {
  it("commits, tags, pushes and creates the release", () => {
    const fx = makeRepo();
    fx.commit("feat(deploy): queue (#10)");
    fx.commit("chore: noise");
    fx.git("push", "origin", "main");
    const h = makeDeps(fx);

    const code = run(["minor", "--publish"], h.deps);

    expect(code, h.text()).toBe(0);
    expect(fx.git("log", "-1", "--format=%s")).toBe("chore(release): v0.2.0");
    expect(fx.git("cat-file", "-t", "v0.2.0")).toBe("tag");
    expect(JSON.parse(readFileSync(join(fx.dir, "package.json"), "utf8")).version).toBe("0.2.0");
    const changelog = readFileSync(join(fx.dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## [Unreleased]");
    expect(changelog.indexOf("[Unreleased]")).toBeLessThan(changelog.indexOf("[0.2.0]"));
    expect(changelog).toContain("- **deploy:** queue (#10)");
    expect(changelog).not.toContain("noise");
    expect(fx.git("status", "--porcelain")).toBe("");
    expect(fx.originGit("rev-parse", "main")).toBe(fx.git("rev-parse", "HEAD"));
    expect(fx.originGit("tag", "--list")).toBe("v0.2.0");

    const create = h.ghCalls.find((c) => c[0] === "release");
    expect(create).toBeDefined();
    expect(create!.slice(0, 5)).toEqual(["release", "create", "v0.2.0", "--title", "v0.2.0"]);
    expect(create).not.toContain("--prerelease");
    expect(h.notes[0]).toContain("- **deploy:** queue (#10)");
    expect(h.notes[0]).not.toContain("## [0.2.0]");
  });

  it("marks release candidates as prereleases", () => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    fx.git("push", "origin", "main");
    const h = makeDeps(fx);
    expect(run(["1.0.0-rc.1", "--publish"], h.deps), h.text()).toBe(0);
    const create = h.ghCalls.find((c) => c[0] === "release")!;
    expect(create).toContain("--prerelease");
    expect(fx.originGit("tag", "--list")).toBe("v1.0.0-rc.1");
  });

  it.each([
    [
      "a dirty tree",
      (fx: Fixture) => writeFileSync(join(fx.dir, "x.txt"), "x"),
      /not clean/,
    ],
    [
      "a branch other than main",
      (fx: Fixture) => void fx.git("switch", "-c", "topic"),
      /not main/,
    ],
    [
      "unpushed local commits",
      (fx: Fixture) => fx.commit("feat: local only (#9)"),
      /1 ahead, 0 behind/,
    ],
  ])("refuses on %s and changes nothing", (_name, setup, message) => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    fx.git("push", "origin", "main");
    setup(fx);
    const before = snapshot(fx);
    const h = makeDeps(fx);

    expect(run(["patch", "--publish"], h.deps)).toBe(1);

    expect(h.text()).toMatch(message);
    expect(h.text()).toContain("Refusing to release");
    expect(snapshot(fx)).toEqual({ ...before, branches: snapshot(fx).branches });
    expect(fx.git("tag", "--list")).toBe("");
    expect(h.ghCalls.filter((c) => c[0] === "release")).toEqual([]);
  });

  it("refuses when behind origin/main", () => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    fx.git("push", "origin", "main");
    const other = join(fx.root, "other");
    execFileSync("git", ["clone", fx.origin, other], { stdio: "ignore" });
    sh(other, ["config", "user.name", "T"]);
    sh(other, ["config", "user.email", "t@example.com"]);
    sh(other, ["commit", "--allow-empty", "-m", "fix: elsewhere (#2)"]);
    sh(other, ["push", "origin", "main"]);
    const h = makeDeps(fx);

    expect(run(["patch", "--publish"], h.deps)).toBe(1);
    expect(h.text()).toMatch(/0 ahead, 1 behind/);
    expect(fx.git("tag", "--list")).toBe("");
  });

  it("refuses a non-increasing version", () => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    fx.git("push", "origin", "main");
    tagAndPush(fx, "v1.0.0");
    fx.commit("fix: b (#2)");
    fx.git("push", "origin", "main");
    const before = snapshot(fx);
    const h = makeDeps(fx);
    expect(run(["1.0.0-rc.1", "--publish"], h.deps)).toBe(1);
    expect(snapshot(fx)).toEqual(before);
  });

  it("states the repo state and recovery commands when gh fails after the push", () => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    fx.git("push", "origin", "main");
    const h = makeDeps(fx, { ghFails: true });

    expect(run(["minor", "--publish"], h.deps)).toBe(1);

    const text = h.text();
    expect(text).toContain("FAILED: gh release create v0.2.0");
    expect(text).toMatch(/tag v0\.2\.0 are pushed, but the GitHub release was not created/);
    expect(text).toContain("To resume, run:");
    expect(text).toMatch(/\n {2}gh release create v0\.2\.0 .*--notes-file/);
    expect(text).toContain("git push origin :refs/tags/v0.2.0");
    expect(fx.originGit("tag", "--list")).toBe("v0.2.0");
  });

  it("states the repo state when the push fails", () => {
    const fx = makeRepo();
    fx.commit("feat: a (#1)");
    fx.git("push", "origin", "main");
    const h = makeDeps(fx);
    const realExec = h.deps.exec;
    h.deps.exec = (cmd, args, o) => {
      if (cmd === "git" && args[0] === "push") throw new Error("remote rejected");
      return realExec(cmd, args, o);
    };

    expect(run(["minor", "--publish"], h.deps)).toBe(1);

    expect(h.text()).toContain("FAILED: git push origin main v0.2.0");
    expect(h.text()).toMatch(/exist locally\. The push failed/);
    expect(h.text()).toContain("git tag -d v0.2.0");
    expect(h.ghCalls.filter((c) => c[0] === "release")).toEqual([]);
    expect(fx.originGit("tag", "--list")).toBe("");
  });
});
