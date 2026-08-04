import { describe, it, expect } from "vitest";
import { previewRefusalReason } from "@/lib/git-integration/pull-request";

describe("previewRefusalReason", () => {
  it("allows a branch of the base repository", () => {
    expect(
      previewRefusalReason({
        baseRepoFullName: "joeyyax/vardo",
        headRepoFullName: "joeyyax/vardo",
        headIsFork: false,
      }),
    ).toBeNull();
  });

  it("refuses a fork, which anyone with an account can open", () => {
    expect(
      previewRefusalReason({
        baseRepoFullName: "joeyyax/vardo",
        headRepoFullName: "outsider/vardo",
        headIsFork: true,
      }),
    ).toMatch(/comes from a fork/);
  });

  it("refuses on the repo names alone when the fork flag is absent", () => {
    expect(
      previewRefusalReason({
        baseRepoFullName: "joeyyax/vardo",
        headRepoFullName: "outsider/vardo",
      }),
    ).toMatch(/outsider\/vardo/);
  });

  it("trusts the fork flag over matching names", () => {
    expect(
      previewRefusalReason({
        baseRepoFullName: "joeyyax/vardo",
        headRepoFullName: "joeyyax/vardo",
        headIsFork: true,
      }),
    ).toMatch(/comes from a fork/);
  });

  it("compares repository names case-insensitively", () => {
    expect(
      previewRefusalReason({
        baseRepoFullName: "JoeyYax/Vardo",
        headRepoFullName: "joeyyax/vardo",
        headIsFork: false,
      }),
    ).toBeNull();
  });

  it("refuses when the head repository is gone, since nothing identifies the source", () => {
    expect(previewRefusalReason({ baseRepoFullName: "joeyyax/vardo", headRepoFullName: null })).toMatch(
      /head repository is unknown/,
    );
  });

  it("refuses when the base repository is missing", () => {
    expect(previewRefusalReason({ baseRepoFullName: "", headRepoFullName: "joeyyax/vardo" })).toMatch(
      /base repository is unknown/,
    );
  });
});
