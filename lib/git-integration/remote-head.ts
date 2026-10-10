// Branch head lookup with `git ls-remote`, authenticated the way a deploy clones. Credentials go in env, never argv.

import { execFileAsync } from "@/lib/utils/exec";
import { assertSafeBranch, assertSafeGitUrl } from "@/lib/docker/validate";
import { assertGitHostAllowed, GIT_NO_REDIRECT } from "@/lib/docker/git-host";
import { splitGitUrl } from "@/lib/api/git-fields";
import { openGitCredentials } from "@/lib/api/git-credentials";
import { getInstallationToken, getRepoInstallationId } from "./app";
import { credentialGitEnv, githubTokenGitEnv, resolveCloneToken } from "./clone-auth";
import { orgInstallations } from "./org-installations";
import {
  buildGitSshCommand,
  cleanupKeyFile,
  getDecryptedPrivateKey,
  writeTemporaryKeyFile,
} from "@/lib/crypto/deploy-key";

const LS_REMOTE_TIMEOUT_MS = 20_000;

export type RemoteApp = {
  organizationId: string;
  gitUrl: string;
  gitCredentials: string | null;
  gitKeyId: string | null;
};

export type GitAuth = { url: string; env: Record<string, string>; cleanup: () => Promise<void> };

/** URL and env for reaching the app's repo, in prepare-repo's order: GitHub App token, deploy key, stored credentials. */
export async function gitAuthFor(app: RemoteApp): Promise<GitAuth> {
  const split = splitGitUrl(app.gitUrl);
  let url = split.url;
  assertSafeGitUrl(url);
  await assertGitHostAllowed(url);
  const credentials = openGitCredentials(app.gitCredentials, app.organizationId) ?? split.credentials;

  if (!credentials && url.startsWith("https://github.com/")) {
    const token = await resolveCloneToken(url, await orgInstallations(app.organizationId), {
      getToken: getInstallationToken,
      getRepoInstallationId,
    }).catch(() => null);
    if (token) return { url, env: githubTokenGitEnv(token), cleanup: async () => {} };
  }

  if (app.gitKeyId) {
    const pem = await getDecryptedPrivateKey(app.gitKeyId, app.organizationId);
    if (pem) {
      const keyFile = await writeTemporaryKeyFile(pem);
      const parsed = new URL(url);
      url = `git@${parsed.hostname}:${parsed.pathname.replace(/^\//, "")}`;
      if (!url.endsWith(".git")) url += ".git";
      return { url, env: { GIT_SSH_COMMAND: buildGitSshCommand(keyFile) }, cleanup: () => cleanupKeyFile(keyFile) };
    }
  }

  if (credentials) return { url, env: credentialGitEnv(url, credentials), cleanup: async () => {} };
  return { url, env: {}, cleanup: async () => {} };
}

/** The branch's head SHA on the remote. Throws when the host errors or the branch is gone. */
export async function lsRemoteHead(app: RemoteApp, branch: string): Promise<string> {
  assertSafeBranch(branch);
  const auth = await gitAuthFor(app);
  try {
    const { stdout } = await execFileAsync(
      "git",
      [...GIT_NO_REDIRECT, "ls-remote", "--", auth.url, `refs/heads/${branch}`],
      { timeout: LS_REMOTE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth.env } },
    );
    const line = String(stdout).split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
    const sha = line?.split("\t")[0];
    if (!sha || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new Error(`Branch ${branch} not found on the remote`);
    }
    return sha;
  } finally {
    await auth.cleanup();
  }
}
