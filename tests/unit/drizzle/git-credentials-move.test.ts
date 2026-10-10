// The 0108 move of git URL userinfo into git_credentials, replayed with the file's own patterns.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitGitUrl } from "@/lib/api/git-fields";

const FILE = readFileSync(join(process.cwd(), "drizzle/0108_store_git_credentials.sql"), "utf8");
const statements = FILE.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--(?!>).*$/gm, "").trim());
const move = statements.find((s) => /^UPDATE "app"/.test(s))!;

// Postgres patterns from the move, run here as JS regexes.
const credsPattern = new RegExp(/substring\("git_url" from '([^']+)'\)/.exec(move)![1]);
const stripPattern = new RegExp(/regexp_replace\("git_url", '([^']+)', '\\1'\)/.exec(move)![1]);
const guardPattern = new RegExp(/WHERE "git_url" ~ '([^']+)'/.exec(move)![1]);

/** One row through the migration's UPDATE. */
function migrate(gitUrl: string | null): { gitUrl: string | null; credentials: string | null } {
  if (gitUrl === null || !guardPattern.test(gitUrl)) return { gitUrl, credentials: null };
  return {
    gitUrl: gitUrl.replace(stripPattern, "$1"),
    credentials: credsPattern.exec(gitUrl)?.[1] || null,
  };
}

const URLS = [
  "https://deploy:tok3n-value@example.com/org/repo.git",
  "https://tok3n-value@example.com/org/repo.git",
  "https://u:p@ss@example.com/r.git",
  "https://example.com/org/repo@v1.git",
  "https://example.com/org/repo.git",
  "git@example.com:org/repo.git",
];

describe("0108 git credential move", () => {
  it("splits each URL the way the app does", () => {
    for (const url of URLS) {
      const split = splitGitUrl(url);
      expect(migrate(url)).toEqual({ gitUrl: split.url, credentials: split.credentials });
    }
  });

  it("is a no-op on a second run", () => {
    for (const url of URLS) {
      const once = migrate(url);
      expect(migrate(once.gitUrl)).toEqual({ gitUrl: once.gitUrl, credentials: null });
    }
    expect(move).toMatch(/WHERE "git_url" ~/);
  });

  it("scrubs snapshots, logs and activity before git_url loses the credentials", () => {
    const order = statements.map((s) => /^UPDATE "(\w+)"/.exec(s)?.[1]).filter(Boolean);
    expect(order).toEqual(["deployment", "deployment", "activity", "app"]);
    expect(statements.find((s) => s.includes('"config_snapshot" = replace'))).toBeTruthy();
    expect(statements.find((s) => s.includes('"log" = replace'))).toBeTruthy();
    expect(statements.find((s) => s.includes('"metadata" = replace'))).toBeTruthy();
  });

  it("leaves JSON intact by skipping userinfo with quotes or backslashes", () => {
    for (const s of statements.filter((s) => /::jsonb/.test(s))) {
      expect(s).toContain(`c.creds !~ '["\\\\]'`);
    }
  });
});
