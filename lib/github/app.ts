import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { createHmac, timingSafeEqual } from "crypto";
import { getGitHubAppConfig } from "@/lib/system-settings";

async function loadGitHubConfig() {
  const config = await getGitHubAppConfig();
  if (!config || !config.appId || !config.privateKey) {
    throw new Error("GitHub App is not configured. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY env vars or complete the setup wizard.");
  }
  return config;
}

export async function getAppOctokit() {
  const config = await loadGitHubConfig();
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
    },
  });
}

export async function getInstallationOctokit(installationId: number) {
  const config = await loadGitHubConfig();
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId,
    },
  });
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const octokit = await getAppOctokit();
  const { data } = await octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });
  return data.token;
}

export async function listInstallationRepos(installationId: number) {
  const octokit = await getInstallationOctokit(installationId);
  const repos: Array<{
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
    htmlUrl: string;
    description: string | null;
  }> = [];

  for await (const response of octokit.paginate.iterator(
    octokit.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 }
  )) {
    for (const repo of response.data) {
      repos.push({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
        description: repo.description,
      });
    }
  }

  return repos;
}

/**
 * Create a new repository via a GitHub App installation.
 * If the installation is on a user account, creates a user repo.
 * If on an org, creates an org repo.
 */
export async function createRepo(
  installationId: number,
  opts: {
    name: string;
    description?: string;
    isPrivate?: boolean;
    owner: string;
    ownerType: "User" | "Organization";
  }
): Promise<{
  id: number;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}> {
  const octokit = await getInstallationOctokit(installationId);

  let data;
  if (opts.ownerType === "Organization") {
    const res = await octokit.rest.repos.createInOrg({
      org: opts.owner,
      name: opts.name,
      description: opts.description,
      private: opts.isPrivate ?? true,
      auto_init: true,
    });
    data = res.data;
  } else {
    const res = await octokit.rest.repos.createForAuthenticatedUser({
      name: opts.name,
      description: opts.description,
      private: opts.isPrivate ?? true,
      auto_init: true,
    });
    data = res.data;
  }

  return {
    id: data.id,
    fullName: data.full_name,
    htmlUrl: data.html_url,
    cloneUrl: data.clone_url,
    defaultBranch: data.default_branch,
  };
}

// HMAC-signed state for CSRF protection during GitHub App installation flow

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getSigningKey() {
  const key = process.env.BETTER_AUTH_SECRET;
  if (!key) throw new Error("BETTER_AUTH_SECRET is not set");
  return key;
}

export function createInstallationState(userId: string): string {
  const payload = JSON.stringify({ userId, ts: Date.now() });
  const encoded = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", getSigningKey())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyInstallationState(
  state: string
): { userId: string } | null {
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) return null;

  const expectedSig = createHmac("sha256", getSigningKey())
    .update(encoded)
    .digest("base64url");

  if (
    !timingSafeEqual(
      Buffer.from(sig, "utf-8"),
      Buffer.from(expectedSig, "utf-8")
    )
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf-8")
    );
    if (Date.now() - payload.ts > STATE_TTL_MS) return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
