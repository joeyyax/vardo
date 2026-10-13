// Pins the shallow deploy clone to one commit, fetching it first when missing.

import { assertSafeGitSha } from "../validate";
import { DeployBlockedError } from "../errors";

/** Injectable git runner. */
export type GitRunner = (args: string[]) => Promise<{ stdout: string }>;

/** Why the deploy ships this commit: a rollback's target, the commit a push named, or one someone pinned. */
export type CheckoutIntent = "rollback" | "push" | "pin";

const WHAT: Record<CheckoutIntent, { error: string; log: string }> = {
  rollback: { error: "Rollback target commit", log: "Rollback: checked out" },
  push: { error: "Pushed commit", log: "Checked out the pushed commit" },
  pin: { error: "Pinned commit", log: "Checked out the pinned commit" },
};

async function hasCommit(git: GitRunner, sha: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Check out `sha` in the working clone. Throws if it can't be resolved; never fall back to the branch tip. */
export async function checkoutCommit(
  git: GitRunner,
  sha: string,
  intent: CheckoutIntent,
  log: (line: string) => void,
): Promise<void> {
  assertSafeGitSha(sha);

  if (!(await hasCommit(git, sha))) {
    const attempts = [
      ["fetch", "--depth", "1", "origin", sha],
      ["fetch", "--unshallow", "origin"],
      ["fetch", "origin"],
    ];
    for (const args of attempts) {
      try {
        await git(args);
      } catch {
        continue;
      }
      if (await hasCommit(git, sha)) break;
    }
  }

  if (!(await hasCommit(git, sha))) {
    throw new DeployBlockedError(
      `${WHAT[intent].error} ${sha} is not available in the repository — ` +
      `the branch may have been force-pushed or the commit garbage collected`,
    );
  }

  await git(["checkout", "--force", "--detach", sha]);
  log(`[deploy] ${WHAT[intent].log} ${sha.slice(0, 7)}`);
}
