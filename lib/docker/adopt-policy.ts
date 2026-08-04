// ---------------------------------------------------------------------------
// Adoption policy
//
// Adoption brings an existing, running service under Vardo, so it is the path
// most likely to carry bind mounts and the one where dropping them costs the
// most. The rule has to match what the deploy path will do with the same
// compose, or adopt refuses what deploy would have permitted.
// ---------------------------------------------------------------------------

/**
 * Whether an adopt may keep bind mounts.
 *
 * The project is the authority, as it is for deploy. A local environment is
 * additionally permitted because it has no project to speak for it in the
 * common case.
 */
export function adoptAllowsBindMounts(input: {
  environmentType: string;
  /** The project's setting, or null when adopting into a project that does not exist yet. */
  projectAllowBindMounts: boolean | null | undefined;
  featureEnabled: boolean;
}): boolean {
  return (
    input.environmentType === "local" ||
    (input.projectAllowBindMounts ?? false) ||
    input.featureEnabled
  );
}
