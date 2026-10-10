import { describe, it, expect } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "d".repeat(64);

import {
  GIT_URL_MASK,
  gitUrlHost,
  joinGitUrl,
  KEEP_GIT_CREDENTIALS,
  maskGitUrl,
  resolveGitUrlInput,
  splitGitUrl,
} from "@/lib/api/git-fields";
import { gitUrlColumns, gitUrlUpdateColumns, openGitCredentials, openGitUrl } from "@/lib/api/git-credentials";
import { readableApp } from "@/lib/api/readable-app";
import { decrypt, isEncrypted } from "@/lib/crypto/encrypt";

const CLEAN = "https://example.com/org/repo.git";
const WITH_PASSWORD = "https://deploy:tok3n-value@example.com/org/repo.git";
const WITH_TOKEN = "https://tok3n-value@example.com/org/repo.git";
const ORG = "org-1";

describe("splitGitUrl and joinGitUrl", () => {
  it("splits user and password off the URL", () => {
    expect(splitGitUrl(WITH_PASSWORD)).toEqual({ url: CLEAN, credentials: "deploy:tok3n-value" });
    expect(splitGitUrl(WITH_TOKEN)).toEqual({ url: CLEAN, credentials: "tok3n-value" });
  });

  it("takes the last @ in the authority, so an unencoded @ in the password stays with it", () => {
    expect(splitGitUrl("https://u:p@ss@example.com/r.git")).toEqual({ url: "https://example.com/r.git", credentials: "u:p@ss" });
  });

  it("leaves an @ in the path alone", () => {
    expect(splitGitUrl("https://example.com/org/repo@v1.git")).toEqual({
      url: "https://example.com/org/repo@v1.git",
      credentials: null,
    });
  });

  it("returns a URL without credentials, or one it can't parse, whole", () => {
    expect(splitGitUrl(CLEAN)).toEqual({ url: CLEAN, credentials: null });
    expect(splitGitUrl("git@example.com:org/repo.git")).toEqual({ url: "git@example.com:org/repo.git", credentials: null });
    expect(splitGitUrl("https://@example.com/r.git")).toEqual({ url: "https://example.com/r.git", credentials: null });
  });

  it("joins back to the original", () => {
    for (const url of [WITH_PASSWORD, WITH_TOKEN, CLEAN, "https://u%40x:p%3Aw@example.com:8443/r"]) {
      const { url: clean, credentials } = splitGitUrl(url);
      expect(joinGitUrl(clean, credentials)).toBe(url);
    }
  });

  it("compares hosts without credentials or case", () => {
    expect(gitUrlHost(WITH_PASSWORD)).toBe("example.com");
    expect(gitUrlHost("https://Example.COM:8443/x")).toBe("example.com:8443");
  });
});

describe("masking", () => {
  it("masks embedded and stored credentials whole", () => {
    expect(maskGitUrl(WITH_PASSWORD)).toBe(`https://${GIT_URL_MASK}@example.com/org/repo.git`);
    expect(maskGitUrl(WITH_TOKEN)).toBe(`https://${GIT_URL_MASK}@example.com/org/repo.git`);
    expect(maskGitUrl(CLEAN, true)).toBe(`https://${GIT_URL_MASK}@example.com/org/repo.git`);
  });

  it("leaves a URL without credentials alone", () => {
    expect(maskGitUrl(CLEAN)).toBe(CLEAN);
    expect(maskGitUrl(null)).toBeNull();
  });

  it("never returns credentials or their ciphertext in an app read", () => {
    const stored = gitUrlColumns(WITH_PASSWORD, ORG);
    const read = readableApp(stored, true) as Record<string, unknown>;
    expect(read.gitUrl).toBe(`https://${GIT_URL_MASK}@example.com/org/repo.git`);
    expect("gitCredentials" in read).toBe(false);
    expect(JSON.stringify(read)).not.toContain("tok3n-value");
  });
});

describe("resolveGitUrlInput", () => {
  const stored = { gitUrl: CLEAN, hasCredentials: true };

  it("keeps the stored credentials when the mask comes back on the same host", () => {
    expect(resolveGitUrlInput(maskGitUrl(CLEAN, true)!, stored)).toEqual({ url: CLEAN, credentials: KEEP_GIT_CREDENTIALS });
    expect(resolveGitUrlInput(`https://${GIT_URL_MASK}@example.com/org/moved.git`, stored)).toEqual({
      url: "https://example.com/org/moved.git",
      credentials: KEEP_GIT_CREDENTIALS,
    });
  });

  it("takes the mask from older reads, user and all", () => {
    expect(resolveGitUrlInput(`https://deploy:${GIT_URL_MASK}@example.com/org/repo.git`, stored)?.credentials).toBe(KEEP_GIT_CREDENTIALS);
  });

  it("clears the credentials when the host changes", () => {
    expect(resolveGitUrlInput(`https://${GIT_URL_MASK}@other.example.com/org/repo.git`, stored)).toEqual({
      url: "https://other.example.com/org/repo.git",
      credentials: null,
    });
  });

  it("refuses the mask with nothing stored to keep", () => {
    expect(resolveGitUrlInput(maskGitUrl(CLEAN, true)!, { gitUrl: CLEAN, hasCredentials: false })).toBeNull();
  });

  it("takes new credentials, or none, as given", () => {
    expect(resolveGitUrlInput("https://new:pw@example.com/x.git", stored)).toEqual({ url: "https://example.com/x.git", credentials: "new:pw" });
    expect(resolveGitUrlInput(CLEAN, stored)).toEqual({ url: CLEAN, credentials: null });
  });
});

describe("stored git credentials", () => {
  it("stores the URL without credentials and the credentials encrypted", () => {
    const cols = gitUrlColumns(WITH_PASSWORD, ORG);
    expect(cols.gitUrl).toBe(CLEAN);
    expect(isEncrypted(cols.gitCredentials!)).toBe(true);
    expect(cols.gitCredentials).not.toContain("tok3n-value");
    expect(decrypt(cols.gitCredentials!, ORG)).toBe("deploy:tok3n-value");
    expect(openGitUrl(cols, ORG)).toBe(WITH_PASSWORD);
  });

  it("round-trips a masked read without touching the stored credentials", () => {
    const cols = gitUrlColumns(WITH_PASSWORD, ORG);
    const shown = readableApp(cols, true).gitUrl!;
    expect(gitUrlUpdateColumns(shown, cols, ORG)).toEqual({ gitUrl: CLEAN });
  });

  it("re-encrypts new credentials and clears them on a host change or empty URL", () => {
    const cols = gitUrlColumns(WITH_PASSWORD, ORG);
    const next = gitUrlUpdateColumns("https://bot:n3w-token@example.com/org/repo.git", cols, ORG)!;
    expect(openGitCredentials(next.gitCredentials, ORG)).toBe("bot:n3w-token");
    expect(gitUrlUpdateColumns(`https://${GIT_URL_MASK}@other.example.com/r.git`, cols, ORG)).toEqual({
      gitUrl: "https://other.example.com/r.git",
      gitCredentials: null,
    });
    expect(gitUrlUpdateColumns("", cols, ORG)).toEqual({ gitUrl: "", gitCredentials: null });
  });

  it("refuses credentials that won't decrypt", () => {
    const cols = gitUrlColumns(WITH_PASSWORD, ORG);
    expect(() => openGitCredentials(cols.gitCredentials, "org-2")).toThrow();
  });

  it("reads legacy plaintext from before the startup pass", () => {
    expect(openGitCredentials("deploy:tok3n-value", ORG)).toBe("deploy:tok3n-value");
  });
});
