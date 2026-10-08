import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { githubTokenGitEnv } from "@/lib/git-integration/clone-auth";

function headerFor(url: string): string {
  try {
    return execFileSync("git", ["config", "--get-urlmatch", "http.extraheader", url], {
      env: { ...process.env, ...githubTokenGitEnv("ghs_test123") },
      cwd: "/",
    }).toString().trim();
  } catch {
    return "";
  }
}

describe("githubTokenGitEnv", () => {
  it("gives git an auth header for github.com", () => {
    const expected = `Authorization: Basic ${Buffer.from("x-access-token:ghs_test123").toString("base64")}`;
    expect(headerFor("https://github.com/owner/repo.git")).toBe(expected);
  });

  it("sends nothing to another host", () => {
    expect(headerFor("https://evil.example.com/owner/repo.git")).toBe("");
  });
});
