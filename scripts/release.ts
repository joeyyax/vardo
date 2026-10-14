#!/usr/bin/env tsx
/**
 * Cuts a release: bumps the version, writes the changelog, tags and publishes.
 *
 * Usage: pnpm release <patch|minor|major|X.Y.Z[-rc.N]> [--publish]
 * Without --publish it is a dry run.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

export type Semver = {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
};

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/** Parses strict semver without build metadata; null when invalid. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

export function formatSemver(s: Semver): string {
  const core = `${s.major}.${s.minor}.${s.patch}`;
  return s.pre.length ? `${core}-${s.pre.join(".")}` : core;
}

const isNumeric = (s: string) => /^\d+$/.test(s);

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid semver: ${!pa ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = isNumeric(x);
    const ny = isNumeric(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export type BumpKind = "patch" | "minor" | "major";

export type BumpResult = { version: string; notes: string[] };

/** Next version for a bump keyword; under 0.x "major" bumps minor. */
export function bumpVersion(
  current: string,
  kind: BumpKind,
  opts: { breaking?: number } = {},
): BumpResult {
  const s = parseSemver(current);
  if (!s) throw new Error(`Invalid semver: ${current}`);
  const notes: string[] = [];
  const breaking = opts.breaking ?? 0;
  let effective = kind;

  if (s.major === 0 && kind === "major") {
    effective = "minor";
    notes.push(
      "Under 0.x a breaking bump increments minor. Pass 1.0.0 explicitly to go stable.",
    );
  }
  if (breaking > 0 && effective === "patch") {
    notes.push(
      `${breaking} breaking change${breaking === 1 ? "" : "s"} since the last tag, but a patch bump was requested.`,
    );
  }

  let { major, minor, patch } = s;
  const wasPre = s.pre.length > 0;
  if (effective === "major") {
    // A prerelease of the next major finalizes in place.
    if (!(wasPre && minor === 0 && patch === 0)) major += 1;
    minor = 0;
    patch = 0;
  } else if (effective === "minor") {
    if (!(wasPre && patch === 0)) minor += 1;
    patch = 0;
  } else if (!wasPre) {
    patch += 1;
  }
  return { version: `${major}.${minor}.${patch}`, notes };
}

export function isPrerelease(v: string): boolean {
  const s = parseSemver(v);
  return !!s && s.pre.length > 0;
}

/** Highest valid `vX.Y.Z[-pre]` tag, optionally stable only. */
export function highestTag(
  tags: string[],
  opts: { stableOnly?: boolean } = {},
): { tag: string; version: string } | null {
  let best: { tag: string; version: string } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue;
    const version = tag.slice(1);
    if (!parseSemver(version)) continue;
    if (opts.stableOnly && isPrerelease(version)) continue;
    if (!best || compareSemver(version, best.version) > 0) best = { tag, version };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export type Commit = {
  type: string | null;
  scope: string | null;
  description: string;
  ref: string | null;
  breaking: boolean;
  raw: string;
  noise: boolean;
};

const CONVENTIONAL_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?: (.+)$/;
const REF_RE = /\s+\(#(\d+)\)$/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;
const NOISE_SUBJECT_RE = /^(Merge |Revert )/;
const DROPPED_TYPES = new Set(["chore", "test", "style", "revert"]);

/** Parses a commit subject and body into its changelog fields. */
export function parseCommit(subject: string, body = ""): Commit {
  const raw = subject.trim();
  const footerBreaking = BREAKING_FOOTER_RE.test(body);
  if (NOISE_SUBJECT_RE.test(raw)) {
    return { type: null, scope: null, description: raw, ref: null, breaking: false, raw, noise: true };
  }
  const m = CONVENTIONAL_RE.exec(raw);
  if (!m) {
    const ref = REF_RE.exec(raw);
    return {
      type: null,
      scope: null,
      description: raw,
      ref: ref ? ref[1] : null,
      breaking: footerBreaking,
      raw,
      noise: false,
    };
  }
  let description = m[4].trim();
  let ref: string | null = null;
  const r = REF_RE.exec(description);
  if (r) {
    ref = r[1];
    description = description.slice(0, r.index);
  }
  const type = m[1].toLowerCase();
  return {
    type,
    scope: m[2]?.trim() || null,
    description,
    ref,
    breaking: !!m[3] || footerBreaking,
    raw,
    noise: type === "revert",
  };
}

export type GroupName = "Features" | "Fixes" | "Performance" | "Other";
export const GROUP_ORDER: GroupName[] = ["Features", "Fixes", "Performance", "Other"];

const TYPE_GROUP: Record<string, GroupName> = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  docs: "Other",
  refactor: "Other",
  build: "Other",
  ci: "Other",
};

export type Entry = { text: string; breaking: boolean };
export type Groups = Record<GroupName, Entry[]>;

export function renderEntry(c: Commit): string {
  const breaking = c.breaking ? "**BREAKING** " : "";
  if (c.type === null) return `${breaking}${c.raw}`;
  const scope = c.scope ? `**${c.scope}:** ` : "";
  const ref = c.ref ? ` (#${c.ref})` : "";
  return `${breaking}${scope}${c.description}${ref}`;
}

/** Groups commits for the changelog; dropped types survive only when breaking. */
export function groupCommits(commits: Commit[]): Groups {
  const groups: Groups = { Features: [], Fixes: [], Performance: [], Other: [] };
  for (const c of commits) {
    if (c.noise) continue;
    let group: GroupName;
    if (c.type === null) group = "Other";
    else if (TYPE_GROUP[c.type]) group = TYPE_GROUP[c.type];
    else if (DROPPED_TYPES.has(c.type)) {
      if (!c.breaking) continue;
      group = "Other";
    } else group = "Other";
    groups[group].push({ text: renderEntry(c), breaking: c.breaking });
  }
  return groups;
}

export function countBreaking(commits: Commit[]): number {
  return commits.filter((c) => !c.noise && c.breaking).length;
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

/** Renders one `## [version] - date` section. */
export function renderSection(opts: {
  version: string;
  date: string;
  groups: Groups;
  initial?: boolean;
}): string {
  const lines = [`## [${opts.version}] - ${opts.date}`, ""];
  if (opts.initial) lines.push("Initial release.", "");
  let any = false;
  for (const name of GROUP_ORDER) {
    const entries = opts.groups[name];
    if (!entries.length) continue;
    any = true;
    lines.push(`### ${name}`, "", ...entries.map((e) => `- ${e.text}`), "");
  }
  if (!any) lines.push("No notable changes.", "");
  return lines.join("\n");
}

/** The section body without its `## [...]` heading, for release notes. */
export function sectionNotes(section: string): string {
  return section.split("\n").slice(1).join("\n").trim() + "\n";
}

const CHANGELOG_HEADER = `# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
`;

/** Inserts a section directly below `## [Unreleased]`, newest first. */
export function prependSection(changelog: string, section: string): string {
  const base = changelog.trim() ? changelog : CHANGELOG_HEADER;
  const lines = base.replace(/\s+$/, "").split("\n");
  const idx = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l));
  const block = section.replace(/\s+$/, "").split("\n");
  if (idx === -1) {
    const first = lines.findIndex((l) => l.startsWith("## ["));
    const at = first === -1 ? lines.length : first;
    const head = lines.slice(0, at);
    while (head.length && head[head.length - 1] === "") head.pop();
    return [...head, "", ...block, "", ...lines.slice(at)].join("\n").replace(/\s+$/, "") + "\n";
  }
  const rest = lines.slice(idx + 1);
  while (rest.length && rest[0] === "") rest.shift();
  return [...lines.slice(0, idx + 1), "", ...block, "", ...rest].join("\n").replace(/\s+$/, "") + "\n";
}

/** Replaces the top-level `"version"` field, leaving formatting intact. */
export function setPackageVersion(pkgText: string, version: string): string {
  const re = /^(\s*"version"\s*:\s*")[^"]*(")/m;
  if (!re.test(pkgText)) throw new Error('package.json has no "version" field');
  return pkgText.replace(re, `$1${version}$2`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export type Exec = (cmd: string, args: string[], opts: { cwd: string }) => string;

export type Deps = {
  cwd: string;
  exec: Exec;
  log: (line: string) => void;
  now: () => Date;
};

const defaultExec: Exec = (cmd, args, { cwd }) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    throw new Error(stderr || e.message);
  }
};

export function defaultDeps(): Deps {
  return {
    cwd: resolve(fileURLToPath(import.meta.url), "../.."),
    exec: defaultExec,
    log: (l) => console.log(l),
    now: () => new Date(),
  };
}

const USAGE = "Usage: pnpm release <patch|minor|major|X.Y.Z[-rc.N]> [--publish]";

export function parseArgs(argv: string[]): { spec: string; publish: boolean } | { error: string } {
  let publish = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--publish") publish = true;
    else if (a.startsWith("-")) return { error: `Unknown option: ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { error: "Expected exactly one version argument." };
  const spec = positional[0].replace(/^v(?=\d)/, "");
  if (!["patch", "minor", "major"].includes(spec) && !parseSemver(spec)) {
    return { error: `Not a bump keyword or valid semver: ${positional[0]}` };
  }
  return { spec, publish };
}

type Step = {
  display: string;
  run: () => void;
  state: string;
  resume: string[];
  undo: string[];
};

/** Runs the release; returns the process exit code. */
export function run(argv: string[], deps: Deps): number {
  const { cwd, exec, log } = deps;
  const git = (...args: string[]) => exec("git", args, { cwd });

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    log(parsed.error);
    log(USAGE);
    return 1;
  }
  const { spec, publish } = parsed;

  const pkgPath = join(cwd, "package.json");
  const changelogPath = join(cwd, "CHANGELOG.md");
  const pkgText = readFileSync(pkgPath, "utf8");
  const pkgVersion = (JSON.parse(pkgText) as { version: string }).version;

  if (publish) {
    try {
      git("fetch", "--tags", "origin", "main");
    } catch (err) {
      log(`Could not fetch origin: ${(err as Error).message}`);
      return 1;
    }
  }

  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  const latest = highestTag(tags);
  const latestStable = highestTag(tags, { stableOnly: true });
  const explicit = parseSemver(spec) !== null;
  const since = explicit && isPrerelease(spec) ? latest : latestStable;

  const range = since ? [`${since.tag}..HEAD`] : ["HEAD"];
  const rawLog = git("log", "--format=%s%x1f%b%x1e", ...range);
  const commits = rawLog
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [subject, body = ""] = r.split("\x1f");
      return parseCommit(subject, body);
    });
  const breaking = countBreaking(commits);

  let version: string;
  const notes: string[] = [];
  if (explicit) {
    version = spec;
  } else {
    const base = latest?.version ?? pkgVersion;
    const bump = bumpVersion(base, spec as BumpKind, { breaking });
    version = bump.version;
    notes.push(...bump.notes);
  }
  const tag = `v${version}`;

  if (latest && compareSemver(version, latest.version) <= 0) {
    log(`Version ${version} must be greater than the latest tag ${latest.tag}.`);
    return 1;
  }
  if (tags.includes(tag)) {
    log(`Tag ${tag} already exists.`);
    return 1;
  }

  const problems: string[] = [];
  const status = git("status", "--porcelain");
  if (status) problems.push("Working tree is not clean.");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") problems.push(`Branch is ${branch}, not main.`);
  try {
    const head = git("rev-parse", "HEAD");
    const remote = git("rev-parse", "origin/main");
    if (head !== remote) {
      const counts = git("rev-list", "--left-right", "--count", "HEAD...origin/main").split(/\s+/);
      problems.push(
        `main is not up to date with origin/main (${counts[0]} ahead, ${counts[1]} behind).`,
      );
    }
  } catch {
    problems.push("origin/main is not available locally.");
  }
  if (!commits.length) problems.push(`No commits since ${since ? since.tag : "the start"}.`);

  const section = renderSection({
    version,
    date: deps.now().toISOString().slice(0, 10),
    groups: groupCommits(commits),
    initial: !since,
  });

  const tmpDir = publish ? mkdtempSync(join(tmpdir(), "vardo-release-")) : join(tmpdir(), "vardo-release-XXXXXX");
  const notesPath = join(tmpDir, "notes.md");
  const message = `chore(release): ${tag}`;
  const ghArgs = [
    "release", "create", tag, "--title", tag, "--notes-file", notesPath,
    ...(isPrerelease(version) ? ["--prerelease"] : []),
  ];
  const ghCmd = `gh ${ghArgs.join(" ")}`;
  const pushCmd = `git push origin main ${tag}`;
  const steps: Step[] = [
    {
      display: "update CHANGELOG.md and package.json",
      run: () => {
        let existing = "";
        try {
          existing = readFileSync(changelogPath, "utf8");
        } catch {
          existing = "";
        }
        writeFileSync(changelogPath, prependSection(existing, section));
        writeFileSync(pkgPath, setPackageVersion(pkgText, version));
        writeFileSync(notesPath, sectionNotes(section));
      },
      state: "CHANGELOG.md and package.json may be modified locally. Nothing is committed.",
      resume: [],
      undo: ["git restore CHANGELOG.md package.json"],
    },
    {
      display: "git add CHANGELOG.md package.json",
      run: () => void git("add", "CHANGELOG.md", "package.json"),
      state: "Changes are modified and possibly staged locally. Nothing is committed.",
      resume: [],
      undo: ["git restore --staged --worktree CHANGELOG.md package.json"],
    },
    {
      display: `git commit -m "${message}"`,
      run: () => void git("commit", "-m", message),
      state: "Changes are staged locally. No commit exists.",
      resume: [`git commit -m "${message}"`, `git tag -a ${tag} -m ${tag}`, pushCmd, ghCmd],
      undo: ["git restore --staged --worktree CHANGELOG.md package.json"],
    },
    {
      display: `git tag -a ${tag} -m ${tag}`,
      run: () => void git("tag", "-a", tag, "-m", tag),
      state: `The release commit exists locally on main. No tag was created. Nothing is pushed.`,
      resume: [`git tag -a ${tag} -m ${tag}`, pushCmd, ghCmd],
      undo: ["git reset --hard HEAD~1"],
    },
    {
      display: pushCmd,
      run: () => void git("push", "origin", "main", tag),
      state: `The release commit and tag ${tag} exist locally. The push failed; check origin before retrying, since it may have partly applied.`,
      resume: [pushCmd, ghCmd],
      undo: [`git tag -d ${tag}`, "git reset --hard HEAD~1"],
    },
    {
      display: ghCmd,
      run: () => void exec("gh", ghArgs, { cwd }),
      state: `main and tag ${tag} are pushed, but the GitHub release was not created. Release notes are saved at ${notesPath}.`,
      resume: [ghCmd],
      undo: [
        `git push origin :refs/tags/${tag}`,
        `git tag -d ${tag}`,
        `git revert HEAD   # the release commit is already on origin/main; revert and push, do not rewrite it`,
      ],
    },
  ];

  log(`Release ${tag}${isPrerelease(version) ? " (prerelease)" : ""}`);
  log(`Previous tag: ${latest ? latest.tag : "none (every commit counts)"}`);
  log(`Changelog base: ${since ? since.tag : "start of history"} (${commits.length} commits, ${breaking} breaking)`);
  for (const n of notes) log(`Note: ${n}`);
  log("");
  log("Changelog section:");
  log("");
  log(section);

  if (!publish) {
    log("Commands that --publish would run:");
    log("  git fetch --tags origin main");
    for (const s of steps) log(`  ${s.display}`);
    log("");
    if (problems.length) {
      log("--publish would refuse right now:");
      for (const p of problems) log(`  - ${p}`);
      log("");
    }
    log("Dry run. Nothing was changed. Re-run with --publish to release.");
    return 0;
  }

  try {
    exec("gh", ["auth", "status"], { cwd });
  } catch (err) {
    problems.push(`gh is not usable: ${(err as Error).message}`);
  }
  if (problems.length) {
    log("Refusing to release:");
    for (const p of problems) log(`  - ${p}`);
    return 1;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    log(`> ${step.display}`);
    try {
      step.run();
    } catch (err) {
      log("");
      log(`FAILED: ${step.display}`);
      log((err as Error).message);
      log("");
      log(`State: ${step.state}`);
      if (step.resume.length) {
        log("To resume, run:");
        for (const c of step.resume) log(`  ${c}`);
      }
      log("To undo, run:");
      for (const c of step.undo) log(`  ${c}`);
      return 1;
    }
  }
  log("");
  log(`Released ${tag}.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2), defaultDeps());
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
