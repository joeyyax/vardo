// ---------------------------------------------------------------------------
// Rollback checkout — pin the working clone to an exact commit.
//
// The deploy clone is shallow at the branch tip, so the rollback target's
// object usually isn't present and has to be fetched first.
// ---------------------------------------------------------------------------

import { assertSafeGitSha } from "../validate";
import { DeployBlockedError } from "../errors";

/** Injectable git runner — the real implementation shells out to `git -C <repo>`. */
export type GitRunner = (args: string[]) => Promise<{ stdout: string }>;

async function hasCommit(git: GitRunner, sha: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check out `sha` in the working clone. Throws if the commit can't be resolved —
 * a rollback that falls through to the branch tip ships the wrong code.
 */
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
