import { describe, it, expect } from "vitest";

import {
  ERROR_SHAPE,
  attributeCounts,
  errorCountQuery,
  lineCountQuery,
} from "@/lib/logging/error-shape";

/** Loki runs RE2; JS is close enough for what the shape actually uses. */
const shape = new RegExp(ERROR_SHAPE.replace("(?i)", ""), "i");

describe("error shape", () => {
  it("matches the level words every runtime spells the same way", () => {
    const lines = [
      "2026-08-02T21:39:19Z ERR Connection terminated error=\"accept stream listener\"",
      "level=error ts=2026-08-03T17:27:41Z msg=\"could not inspect container info\"",
      "2026-08-03 10:27:38.351 PDT [52161] FATAL:  role \"root\" does not exist",
      "[Error] EventAggregator: ExtraService failed while processing",
      "Traceback (most recent call last):",
      "panic: runtime error: invalid memory address",
      "java.lang.NullPointerException: null",
      "CRITICAL Worker exited prematurely",
    ];
    for (const line of lines) expect(shape.test(line)).toBe(true);
  });

  it("leaves ordinary output alone", () => {
    const lines = [
      "GET /health 200 1.2ms",
      "INFO Started server on :3000",
      "2026-08-03 07:28:36 INF Created or updated directory dir.name=uploads",
      "Terrorist Attack S01E02 imported",
      "debug: cache warm",
    ];
    for (const line of lines) expect(shape.test(line)).toBe(false);
  });

  it("ends on a word boundary, so a longer word is not a match", () => {
    expect(shape.test("errors_total 4")).toBe(false);
    expect(shape.test("criticality=low")).toBe(false);
  });
});

describe("queries", () => {
  it("counts by app and service over the sample window", () => {
    expect(errorCountQuery(300)).toBe(
      `sum by (project_id, service) (count_over_time({project_id=~".+"} |~ \`${ERROR_SHAPE}\` [300s]))`,
    );
  });

  it("counts a runtime's exception class names, which carry no leading boundary", () => {
    expect(shape.test("java.lang.IllegalStateException: closed")).toBe(true);
    expect(shape.test("ValueError: invalid literal for int()")).toBe(true);
    expect(shape.test("[ioredis] Unhandled error event: Error: connect ETIMEDOUT")).toBe(true);
  });

  it("counts total lines over the same window and grouping", () => {
    expect(lineCountQuery(300)).toBe(
      'sum by (project_id, service) (count_over_time({project_id=~".+"} [300s]))',
    );
  });

});

describe("attributeCounts", () => {
  const APPS = [
    { id: "stack", parentAppId: null, composeService: null },
    { id: "web", parentAppId: "stack", composeService: "web" },
    { id: "worker", parentAppId: "stack", composeService: "worker" },
  ];

  const SERIES = [
    { labels: { project_id: "stack", service: "web" }, value: 4 },
    { labels: { project_id: "stack", service: "worker" }, value: 6 },
  ];

  it("gives a stack child its own service and the parent the whole stack", () => {
    const counts = attributeCounts(SERIES, APPS);
    expect(counts.get("web")).toBe(4);
    expect(counts.get("worker")).toBe(6);
    expect(counts.get("stack")).toBe(10);
  });

  it("skips a series carrying no app id", () => {
    const counts = attributeCounts([{ labels: { service: "web" }, value: 9 }], APPS);
    expect(counts.size).toBe(0);
  });

  it("skips a value Loki could not produce", () => {
    const counts = attributeCounts([{ labels: { project_id: "stack" }, value: NaN }], APPS);
    expect(counts.size).toBe(0);
  });
});
