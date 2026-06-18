import { describe, it, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// vardo_create_app — deployType param
// ---------------------------------------------------------------------------
// The MCP create-app tool exposes an optional deployType that is passed
// straight through to the app record instead of the old hardcoded "compose".
// It must default to "compose" (auto-detect cascade) and honor a passed value.
//
// Extracted from:
//   lib/mcp/tools/create-app.ts  (deployType zod param)

// Note: "image" is intentionally NOT valid here — the tool only creates
// git-sourced apps, and an image deploy needs an imageName the tool does not
// accept. Keep this enum in sync with lib/mcp/tools/create-app.ts.
const deployTypeSchema = z
  .enum(["compose", "dockerfile", "static", "nixpacks", "railpack"])
  .default("compose");

describe("create-app deployType param", () => {
  it("defaults to compose when omitted", () => {
    expect(deployTypeSchema.parse(undefined)).toBe("compose");
  });

  it("honors a passed deployType", () => {
    expect(deployTypeSchema.parse("nixpacks")).toBe("nixpacks");
    expect(deployTypeSchema.parse("dockerfile")).toBe("dockerfile");
  });

  it("rejects an unknown deployType", () => {
    expect(deployTypeSchema.safeParse("bogus").success).toBe(false);
  });

  it("rejects 'image' — not coherent for a git-sourced app", () => {
    expect(deployTypeSchema.safeParse("image").success).toBe(false);
  });
});
