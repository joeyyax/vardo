// Adoption policy. Must match the deploy path's bind-mount rule.

/** Whether an adopt may keep bind mounts: local environments, the project setting or the feature flag. */
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
