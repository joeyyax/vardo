import { describe, it, expect } from "vitest";

import { maskGitUrl, unmaskGitUrl } from "@/lib/api/git-fields";
import { readableApp } from "@/lib/api/readable-app";

const WITH_PASSWORD = "https://deploy:tok3n-value@example.com/org/repo.git";
const WITH_TOKEN = "https://tok3n-value@example.com/org/repo.git";

describe("git URL credentials", () => {
  it("masks a password and a lone token", () => {
    expect(maskGitUrl(WITH_PASSWORD)).toBe("https://deploy:********@example.com/org/repo.git");
    expect(maskGitUrl(WITH_TOKEN)).toBe("https://********@example.com/org/repo.git");
  });

  it("leaves a URL without credentials alone", () => {
    expect(maskGitUrl("https://example.com/org/repo.git")).toBe("https://example.com/org/repo.git");
    expect(maskGitUrl(null)).toBeNull();
  });

  it("restores the stored URL when its masked form comes back", () => {
    expect(unmaskGitUrl(maskGitUrl(WITH_PASSWORD)!, WITH_PASSWORD)).toBe(WITH_PASSWORD);
  });

  it("refuses a masked URL that no longer matches what's stored", () => {
    expect(unmaskGitUrl("https://deploy:********@example.com/other/repo.git", WITH_PASSWORD)).toBeNull();
    expect(unmaskGitUrl("https://deploy:********@example.com/org/repo.git", null)).toBeNull();
  });

  it("takes a new URL as given", () => {
    expect(unmaskGitUrl("https://new:pw@example.com/x.git", WITH_PASSWORD)).toBe("https://new:pw@example.com/x.git");
  });

  it("never returns credentials in an app read", () => {
    expect(readableApp({ gitUrl: WITH_PASSWORD }, true).gitUrl).not.toContain("tok3n-value");
  });
});
