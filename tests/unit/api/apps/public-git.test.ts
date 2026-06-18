import { describe, it, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Public Git URL apps — create schema validation
// ---------------------------------------------------------------------------
// A git-sourced app pointing at a PUBLIC repo needs only an HTTPS gitUrl —
// there is no GitHub-connection / installation requirement in the create
// schema. This mirrors the engine, which clones public repos without auth.
//
// Extracted from:
//   app/api/v1/organizations/[orgId]/apps/route.ts  (create schema + refine)

const createSchema = z
  .object({
    source: z.enum(["git", "direct"]),
    deployType: z.enum([
      "compose",
      "dockerfile",
      "image",
      "static",
      "nixpacks",
      "railpack",
    ]),
    gitUrl: z
      .string()
      .url()
      .refine((url) => url.startsWith("https://"), {
        message: "Only HTTPS git URLs are allowed",
      })
      .optional(),
    gitBranch: z
      .string()
      .regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name")
      .optional(),
    imageName: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.source === "git") return !!data.gitUrl;
      if (data.deployType === "image") return !!data.imageName;
      return true;
    },
    { message: "Required fields missing for the selected configuration" }
  );

describe("public git URL app creation", () => {
  it("accepts source=git with a public gitUrl and no GitHub connection", () => {
    const result = createSchema.safeParse({
      source: "git",
      deployType: "compose",
      gitUrl: "https://github.com/vercel/next.js.git",
      gitBranch: "main",
    });
    expect(result.success).toBe(true);
  });

  it("does not require any connection/installation field", () => {
    // The schema has no `installationId` or connection key — a bare public
    // gitUrl is sufficient.
    const result = createSchema.safeParse({
      source: "git",
      deployType: "compose",
      gitUrl: "https://gitlab.com/some/public-repo.git",
    });
    expect(result.success).toBe(true);
  });

  it("rejects source=git without a gitUrl", () => {
    const result = createSchema.safeParse({
      source: "git",
      deployType: "compose",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-HTTPS gitUrl", () => {
    const result = createSchema.safeParse({
      source: "git",
      deployType: "compose",
      gitUrl: "git@github.com:user/repo.git",
    });
    expect(result.success).toBe(false);
  });
});
