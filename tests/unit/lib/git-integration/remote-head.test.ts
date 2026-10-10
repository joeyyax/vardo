// ls-remote authenticates through env, the way a deploy clones. Credentials never reach argv.

import { describe, it, expect, vi, beforeEach } from "vitest";

const SHA = "c".repeat(40);
const { execFileAsync, state } = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  state: { credentials: null as string | null, token: null as string | null, pem: null as string | null },
}));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync }));
vi.mock("@/lib/docker/git-host", () => ({
  assertGitHostAllowed: vi.fn().mockResolvedValue(undefined),
  GIT_NO_REDIRECT: ["-c", "http.followRedirects=false"],
}));
vi.mock("@/lib/api/git-credentials", () => ({ openGitCredentials: () => state.credentials }));
vi.mock("@/lib/git-integration/org-installations", () => ({
  orgInstallations: async () => [{ installationId: 1, accountLogin: "acme" }],
}));
vi.mock("@/lib/git-integration/app", () => ({
  getInstallationToken: async () => {
    if (!state.token) throw new Error("no token");
    return state.token;
  },
  getRepoInstallationId: async () => 1,
}));
vi.mock("@/lib/crypto/deploy-key", () => ({
  getDecryptedPrivateKey: async () => state.pem,
  writeTemporaryKeyFile: async () => "/tmp/.host-deploy-key-test",
  cleanupKeyFile: vi.fn(),
  buildGitSshCommand: (p: string) => `ssh -i "${p}" -o StrictHostKeyChecking=accept-new`,
}));

const { lsRemoteHead } = await import("@/lib/git-integration/remote-head");

const app = {
  organizationId: "org-a",
  gitUrl: "https://github.com/acme/site.git",
  gitCredentials: null as string | null,
  gitKeyId: null as string | null,
};

function lastCall(): { args: string[]; env: Record<string, string> } {
  const [, args, opts] = execFileAsync.mock.calls.at(-1)!;
  return { args, env: opts.env };
}

beforeEach(() => {
  execFileAsync.mockReset();
  execFileAsync.mockResolvedValue({ stdout: `${SHA}\trefs/heads/main\n`, stderr: "" });
  state.credentials = null;
  state.token = null;
  state.pem = null;
});

describe("lsRemoteHead", () => {
  it("reads the head of the branch", async () => {
    expect(await lsRemoteHead(app, "main")).toBe(SHA);
    expect(lastCall().args).toEqual(["-c", "http.followRedirects=false", "ls-remote", "--", "https://github.com/acme/site.git", "refs/heads/main"]);
    expect(lastCall().env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("sends a GitHub App token in env only", async () => {
    state.token = "ghs_installationtoken";
    await lsRemoteHead(app, "main");
    const { args, env } = lastCall();
    expect(args.join(" ")).not.toContain("ghs_installationtoken");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", ""), "base64").toString()).toBe(
      "x-access-token:ghs_installationtoken",
    );
  });

  it("sends stored credentials in env only", async () => {
    state.credentials = "deployer:s3cretpass";
    await lsRemoteHead({ ...app, gitUrl: "https://git.example.com/acme/site.git" }, "main");
    const { args, env } = lastCall();
    expect(args.join(" ")).not.toContain("s3cretpass");
    expect(args).toContain("https://git.example.com/acme/site.git");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://git.example.com/.extraheader");
  });

  it("strips credentials embedded in a legacy URL out of argv", async () => {
    await lsRemoteHead({ ...app, gitUrl: "https://deployer:inlinepass@git.example.com/acme/site.git" }, "main");
    const { args, env } = lastCall();
    expect(args.join(" ")).not.toContain("inlinepass");
    expect(env.GIT_CONFIG_VALUE_0).toBeDefined();
  });

  it("uses a deploy key through GIT_SSH_COMMAND and removes the key file", async () => {
    state.pem = "-----BEGIN OPENSSH PRIVATE KEY-----";
    await lsRemoteHead({ ...app, gitKeyId: "key-1" }, "main");
    const { args, env } = lastCall();
    expect(args).toContain("git@github.com:acme/site.git");
    expect(args.join(" ")).not.toContain("PRIVATE KEY");
    expect(env.GIT_SSH_COMMAND).toContain("/tmp/.host-deploy-key-test");
    const { cleanupKeyFile } = await import("@/lib/crypto/deploy-key");
    expect(cleanupKeyFile).toHaveBeenCalledWith("/tmp/.host-deploy-key-test");
  });

  it("refuses a branch that reads as an option before running git", async () => {
    await expect(lsRemoteHead(app, "--upload-pack=touch")).rejects.toThrow(/Invalid branch/);
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it("throws when the branch is missing", async () => {
    execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    await expect(lsRemoteHead(app, "main")).rejects.toThrow(/not found/);
  });
});
