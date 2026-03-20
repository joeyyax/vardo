import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { createHmac, timingSafeEqual } from "crypto";

function getPrivateKey(): string {
  const b64 = process.env.GITHUB_PRIVATE_KEY;
  if (!b64) throw new Error("GITHUB_PRIVATE_KEY is not set");
  return Buffer.from(b64, "base64").toString("utf-8");
}

export function getAppOctokit() {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID!,
      privateKey: getPrivateKey(),
    },
  });
}

export function getInstallationOctokit(installationId: number) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID!,
      privateKey: getPrivateKey(),
      installationId,
    },
  });
}

export async function listInstallationRepos(installationId: number) {
  const octokit = getInstallationOctokit(installationId);
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
