// Serializes host-global prunes: the post-deploy prune and the host reclaim.

export const PRUNE_LOCK_KEY = "deploy:prune:lock";
export const PRUNE_LOCK_TTL_MS = 5 * 60_000;
