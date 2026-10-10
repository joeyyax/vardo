// Adoption policy. Must match the deploy path's bind-mount rule.

/** Whether an adopt may keep bind mounts: a trusted org, the project setting or the feature flag. */
export function adoptAllowsBindMounts(input: {
  orgTrusted: boolean;
  /** The project's setting, or null when adopting into a project that does not exist yet. */
  projectAllowBindMounts: boolean | null | undefined;
  featureEnabled: boolean;
}): boolean {
  return (
    input.orgTrusted ||
    (input.projectAllowBindMounts ?? false) ||
    input.featureEnabled
  );
}
