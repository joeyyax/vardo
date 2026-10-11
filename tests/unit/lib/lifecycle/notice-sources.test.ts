import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { describe, it, expect } from "vitest";

const LIFECYCLE_TYPES =
  /type:\s*"system\.(update-started|updated|update-failed|update-skipped|shutdown|started|recovered-unclean|restarting|restarted|restart-failed|containers-missing)"/;

// The two senders, the type definitions and the email fixtures.
const ALLOWED = new Set(["lib/self-update/lifecycle.ts", "lib/lifecycle/notices.ts", "lib/bus/events.ts", "lib/email/fixtures.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("Vardo lifecycle notices", () => {
  it("are built only in the update and lifecycle notice modules", () => {
    const root = process.cwd();
    const offenders = ["lib", "app", "components"]
      .flatMap((dir) => sources(join(root, dir)))
      .map((path) => relative(root, path))
      .filter((path) => !ALLOWED.has(path) && LIFECYCLE_TYPES.test(readFileSync(join(root, path), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
