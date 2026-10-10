/** The element id of a backup job's card, for `/backups#job-<id>` links. */
export function jobAnchor(jobId: string): string {
  return `job-${jobId}`;
}
