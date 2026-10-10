import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Helper containers stream archives, certs and .env files over stdout. With a log driver
// on, Docker keeps that output and log shippers forward it.

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("one-shot helper containers", () => {
  it("run with logging off", () => {
    const offenders: string[] = [];
    for (const file of sources(join(process.cwd(), "lib"))) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/"run",\s*"--rm"/.test(line) && !line.includes('"--log-driver", "none"')) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
