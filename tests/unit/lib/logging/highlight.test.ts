import { describe, it, expect } from "vitest";
import { highlightLine, escapeHtml, serviceColor } from "@/lib/logging/highlight";

describe("escapeHtml", () => {
  it("neutralizes markup in log output", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(\"x\")&lt;/script&gt;"
    );
  });
});

describe("highlightLine", () => {
  it("never emits raw markup from the log line", () => {
    expect(highlightLine("<img onerror=x>")).not.toContain("<img");
  });

  it("colors deploy markers", () => {
    expect(highlightLine("[deploy] starting")).toContain("text-cyan-400");
  });

  it("marks every occurrence of the query", () => {
    const html = highlightLine("req=abc and req=abc", "req");
    expect(html.match(/<mark/g)).toHaveLength(2);
  });

  it("marks the active occurrence differently", () => {
    const html = highlightLine("req=abc and req=abc", "req", 1);
    expect(html.match(/bg-amber-400 /g)).toHaveLength(1);
    expect(html.match(/bg-amber-400\/25/g)).toHaveLength(1);
  });

  it("matches text that had to be escaped", () => {
    const html = highlightLine("a <b> c", "<b>");
    expect(html).toContain("<mark");
    expect(html).toContain("&lt;b&gt;");
  });

  it("leaves the line alone without a query", () => {
    expect(highlightLine("plain output")).not.toContain("<mark");
  });
});

describe("serviceColor", () => {
  it("is stable per service and varies between them", () => {
    expect(serviceColor("postgres")).toBe(serviceColor("postgres"));
    expect(serviceColor("postgres")).not.toBe(serviceColor("worker"));
  });
});
