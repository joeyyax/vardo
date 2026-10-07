// Which pull requests may become previews. Anyone can trigger a signed fork-PR webhook on a public repo.

/** Why a PR was refused a preview, or null when it may have one. */
export function previewRefusalReason(payload: {
  baseRepoFullName?: string | null;
  headRepoFullName?: string | null;
  headIsFork?: boolean | null;
}): string | null {
  const base = payload.baseRepoFullName?.trim();
  const head = payload.headRepoFullName?.trim();

  // A deleted fork leaves head.repo null.

  if (!head) return "pull request head repository is unknown";
  if (!base) return "pull request base repository is unknown";

  if (payload.headIsFork === true || head.toLowerCase() !== base.toLowerCase()) {
    return `pull request comes from a fork (${head}) — previews only build branches of ${base}`;
  }

  return null;
}
