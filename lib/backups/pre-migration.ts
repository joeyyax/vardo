// Pre-migration backup assessment.

export type AssessedVolume = {
  type: "named" | "bind";
  persistent: boolean;
};

export type PreMigrationAssessment = {
  /** Code lives in git, so only volume data is at risk. */
  gitSourced: boolean;
  namedVolumes: number;
  bindMounts: number;
  worthBackingUp: boolean;
  /** The engine tars named volumes only; bind mounts need a host-side copy. */
  needsManualCopy: boolean;
};

/** Whether an app's data needs a backup before a datastore major-version migration. */
export function assessPreMigrationBackup(input: {
  source: "git" | "direct";
  volumes: AssessedVolume[];
}): PreMigrationAssessment {
  const persistent = input.volumes.filter((v) => v.persistent);
  const namedVolumes = persistent.filter((v) => v.type === "named").length;
  const bindMounts = persistent.filter((v) => v.type === "bind").length;

  return {
    gitSourced: input.source === "git",
    namedVolumes,
    bindMounts,
    worthBackingUp: namedVolumes + bindMounts > 0,
    needsManualCopy: bindMounts > 0,
  };
}
