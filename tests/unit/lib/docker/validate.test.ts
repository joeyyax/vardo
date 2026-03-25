import { describe, it, expect } from "vitest";
import { assertSafeName, assertSafeBranch } from "@/lib/docker/validate";

describe("assertSafeName", () => {
  it("accepts valid names", () => {
    expect(() => assertSafeName("my-app")).not.toThrow();
    expect(() => assertSafeName("my_app")).not.toThrow();
    expect(() => assertSafeName("my.app")).not.toThrow();
    expect(() => assertSafeName("app123")).not.toThrow();
    expect(() => assertSafeName("a")).not.toThrow();
  });

  it("rejects names with spaces", () => {
    expect(() => assertSafeName("my app")).toThrow("Invalid name");
  });

  it("rejects names with shell metacharacters", () => {
    expect(() => assertSafeName("app;rm -rf /")).toThrow("Invalid name");
    expect(() => assertSafeName("app$(whoami)")).toThrow("Invalid name");
    expect(() => assertSafeName("app`id`")).toThrow("Invalid name");
    expect(() => assertSafeName("app|cat")).toThrow("Invalid name");
    expect(() => assertSafeName("app&bg")).toThrow("Invalid name");
  });

  it("rejects names with slashes", () => {
    expect(() => assertSafeName("path/to/app")).toThrow("Invalid name");
  });

  it("rejects empty string", () => {
    expect(() => assertSafeName("")).toThrow("Invalid name");
  });
});

describe("assertSafeBranch", () => {
  it("accepts valid branch names", () => {
    expect(() => assertSafeBranch("main")).not.toThrow();
    expect(() => assertSafeBranch("feature/my-branch")).not.toThrow();
    expect(() => assertSafeBranch("v1.0.0")).not.toThrow();
    expect(() => assertSafeBranch("release/2026.03")).not.toThrow();
  });

  it("rejects branch names with shell metacharacters", () => {
    expect(() => assertSafeBranch("branch;rm -rf /")).toThrow(
      "Invalid branch name",
    );
    expect(() => assertSafeBranch("branch$(whoami)")).toThrow(
      "Invalid branch name",
    );
  });

  it("rejects branch names with spaces", () => {
    expect(() => assertSafeBranch("my branch")).toThrow("Invalid branch name");
  });

  it("rejects empty string", () => {
    expect(() => assertSafeBranch("")).toThrow("Invalid branch name");
  });
});
