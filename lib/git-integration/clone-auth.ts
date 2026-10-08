/** Git config through the environment: a github.com auth header that isn't written to disk or argv. */
export function githubTokenGitEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export function parseGithubRepo(gitUrl: string): { owner: string; repo: string } | null {
  const m = gitUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export type CloneInstallation = { installationId: number; accountLogin: string };

export interface CloneTokenDeps {
  getToken: (installationId: number) => Promise<string>;
  /** Installation of the GitHub App on the repo, or null when it isn't installed. */
  getRepoInstallationId: (owner: string, repo: string) => Promise<number | null>;
  log?: (msg: string) => void;
}

/** Token from the installation that covers the repo: GitHub's answer, then the owner's account, then each in turn. */
export async function resolveCloneToken(
  gitUrl: string,
  installations: CloneInstallation[],
  deps: CloneTokenDeps,
): Promise<string | null> {
  const parsed = parseGithubRepo(gitUrl);
  const ordered: CloneInstallation[] = [];
  const add = (i: CloneInstallation | undefined) => {
    if (i && !ordered.some((o) => o.installationId === i.installationId)) ordered.push(i);
  };

  if (parsed) {
    try {
      const id = await deps.getRepoInstallationId(parsed.owner, parsed.repo);
      if (id !== null) add(installations.find((i) => i.installationId === id));
    } catch { /* fall through to the owner match */ }
    const owner = parsed.owner.toLowerCase();
    for (const i of installations) if (i.accountLogin.toLowerCase() === owner) add(i);
  }
  for (const i of installations) add(i);

  for (const inst of ordered) {
    try {
      const token = await deps.getToken(inst.installationId);
      deps.log?.(`[deploy] Got GitHub token via ${inst.accountLogin}`);
      return token;
    } catch { /* try next */ }
  }
  return null;
}
