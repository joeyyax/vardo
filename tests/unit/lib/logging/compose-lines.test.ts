import { describe, it, expect } from "vitest";
import { parseComposeLine, interleaveByTimestamp } from "@/lib/logging/compose-lines";

describe("parseComposeLine", () => {
  it("splits the service prefix from the message", () => {
    expect(parseComposeLine("postgres-1  | LOG:  ready")).toEqual({
      text: "LOG:  ready",
      service: "postgres",
      timestamp: undefined,
    });
  });

  it("keeps dashes in the service name", () => {
    expect(parseComposeLine("authentik-db-1  | started").service).toBe("authentik-db");
  });

  it("pulls out the timestamp compose adds with --timestamps", () => {
    expect(parseComposeLine("worker-1  | 2026-08-02T03:02:54.218000000Z task done")).toEqual({
      text: "task done",
      service: "worker",
      timestamp: "2026-08-02T03:02:54.218000000Z",
    });
  });

  it("passes unprefixed output through", () => {
    expect(parseComposeLine("plain line")).toEqual({ text: "plain line" });
  });
});

describe("interleaveByTimestamp", () => {
  it("orders services against each other", () => {
    const lines = [
      { text: "pg late", service: "postgres", timestamp: "2026-08-02T03:00:03Z" },
      { text: "pg early", service: "postgres", timestamp: "2026-08-02T03:00:01Z" },
      { text: "web", service: "web", timestamp: "2026-08-02T03:00:02Z" },
    ];
    expect(interleaveByTimestamp(lines).map((l) => l.text)).toEqual(["pg early", "web", "pg late"]);
  });

  it("keeps untimestamped continuation lines with the line above", () => {
    const lines = [
      { text: "traceback", service: "worker", timestamp: "2026-08-02T03:00:05Z" },
      { text: "  File x", service: "worker" },
      { text: "earlier", service: "web", timestamp: "2026-08-02T03:00:01Z" },
    ];
    expect(interleaveByTimestamp(lines).map((l) => l.text)).toEqual([
      "earlier", "traceback", "  File x",
    ]);
  });

  it("is stable for equal timestamps", () => {
    const lines = [
      { text: "a", timestamp: "2026-08-02T03:00:01Z" },
      { text: "b", timestamp: "2026-08-02T03:00:01Z" },
    ];
    expect(interleaveByTimestamp(lines).map((l) => l.text)).toEqual(["a", "b"]);
  });
});
