import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "app/(authenticated)/apps/[...slug]");
const header = readFileSync(join(dir, "app-header.tsx"), "utf8");
const compose = readFileSync(join(dir, "compose-detail.tsx"), "utf8");

// The header once fed Uptime the last successful deploy, so an app with twelve
// restarts on a container 21h old read "50d 14h".
describe("app header uptime", () => {
  it("reads the running container's start", () => {
    expect(header).toMatch(/const uptimeSince = stack \? stackUptimeSince : isRunning \? app\.containerStartedAt/);
  });

  it("never takes a deployment timestamp", () => {
    const stat = header.slice(header.indexOf('label="Uptime"'), header.indexOf("</HeaderStat>", header.indexOf('label="Uptime"')));
    expect(stat).toMatch(/<Uptime since=\{uptimeSince\} \/>/);
    expect(stat).not.toMatch(/lastSuccess|finishedAt|startedAt/);
  });

  it("keeps time since deploy under its own label", () => {
    expect(header).toMatch(/label="Last deploy"/);
  });
});

describe("compose parent uptime", () => {
  it("rolls up the same services the page lists beneath the header", () => {
    expect(compose).toMatch(/stack=\{rollupHealth\(services\)\}/);
    expect(compose).toMatch(/stackUptimeSince=\{rollupUptimeSince\(services\)\}/);
  });
});
