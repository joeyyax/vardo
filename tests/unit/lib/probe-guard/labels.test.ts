import { describe, expect, it } from "vitest";
import { CUSTOM_RULE_ID, hitLabel, hitRuleId, pathLabeler } from "@/lib/probe-guard/labels";
import type { CustomBlock } from "@/lib/probe-guard/blocks";

const BLOCKS: CustomBlock[] = [
  { kind: "prefix", value: "/internal" },
  { kind: "prefix", value: "/telescope", template: "laravel" },
];

describe("hitRuleId", () => {
  it("prefers a managed rule", () => {
    expect(hitRuleId("/.env", BLOCKS)).toBe("dotenv");
  });

  it("counts an owner's entry as custom and a template's under the template", () => {
    expect(hitRuleId("/internal/x", BLOCKS)).toBe(CUSTOM_RULE_ID);
    expect(hitRuleId("/telescope/requests", BLOCKS)).toBe("template:laravel");
  });

  it("falls back to other when nothing matches", () => {
    expect(hitRuleId("/hello", BLOCKS)).toBe("other");
  });
});

describe("hitLabel", () => {
  it("labels each kind of id", () => {
    expect(hitLabel("dotenv")).toBe("env files");
    expect(hitLabel(CUSTOM_RULE_ID)).toBe("turn-away entries");
    expect(hitLabel("template:laravel")).toBe("Laravel");
    expect(hitLabel("template:gone")).toBe("turn-away entries");
    expect(hitLabel("other")).toBe("other paths");
  });
});

describe("pathLabeler", () => {
  it("uses each app's own entries", () => {
    const label = pathLabeler(new Map([["app1", BLOCKS]]));
    expect(label("/internal/x", "app1")).toBe("turn-away entries");
    expect(label("/internal/x", "app2")).toBe("other paths");
    expect(label("/internal/x", null)).toBe("other paths");
  });
});
