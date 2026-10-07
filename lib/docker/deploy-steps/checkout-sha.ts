// Pins the shallow deploy clone to a rollback commit, fetching it first when missing.

import { assertSafeGitSha } from "../validate";
import { DeployBlockedError } from "../errors";

/** Injectable git runner. */
export type GitRunner = (args: string[]) => Promise<{ stdout: string }>;

async function hasCommit(git: GitRunner, sha: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Check out `sha` in the working clone. Throws if it can't be resolved; never fall back to the branch tip. */
export async function checkoutRollbackSha(
  git: GitRunner,
  sha: string,
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
      `Rollback target commit ${sha} is not available in the repository — ` +
      `the branch may have been force-pushed or the commit garbage collected`,
    );
  }

  await git(["checkout", "--force", "--detach", sha]);
  log(`[deploy] Rollback: checked out ${sha.slice(0, 7)}`);
}
