import { describe, it, expect } from "vitest";
import { crashReason, relevantLogTail } from "@/lib/docker/deploy-log-tail";

const crashLog = [
  "[deploy] Starting deployment dep_1",
  "[health] meilisearch: crashed (crash-looping, 5 restarts)",
  "[deploy] Health check failed — fetching container logs...",
  "[deploy][crash] meilisearch-1  | 2026-10-09T17:02:11Z INFO  meilisearch: Starting Meilisearch",
  "[deploy][crash] meilisearch-1  | Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
  "[deploy][crash] meilisearch-1 exited with code 1 (restarting)",
  "[deploy] Tearing down green",
  "[timing] pull 8.2s, up 3.1s",
  "[deploy] ERROR: green slot did not become healthy: meilisearch crashed (crash-looping, 5 restarts)",
];

describe("deploy log tail", () => {
  it("prefers the container output the health gate captured", () => {
    expect(relevantLogTail(crashLog)).toEqual([
      "meilisearch-1  | 2026-10-09T17:02:11Z INFO  meilisearch: Starting Meilisearch",
      "meilisearch-1  | Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
      "meilisearch-1 exited with code 1 (restarting)",
    ]);
  });

  it("falls back to the deploy log without timing lines", () => {
    const build = ["[deploy] Building", "[timing] build 3.0s", "#12 ERROR: exit code: 2", "[deploy] ERROR: Build failed"];
    expect(relevantLogTail(build)).toEqual(["[deploy] Building", "#12 ERROR: exit code: 2", "[deploy] ERROR: Build failed"]);
    expect(relevantLogTail(Array.from({ length: 40 }, (_, i) => `line ${i}`))).toHaveLength(20);
  });

  it("finds the crash reason in the container output", () => {
    expect(crashReason(crashLog)).toBe(
      "Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
    );
    expect(crashReason(["[deploy] ERROR: Build failed"])).toBeUndefined();
  });
});
