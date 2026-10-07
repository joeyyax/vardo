export type PreviewStatus = "loading" | "ready" | "failed";

/** Delete dialog confirm state. Blocked until the volume check settles. */
export function deleteConfirmState(opts: {
  preview: PreviewStatus;
  hasData: boolean;
  deleteVolumes: boolean;
  typed: string;
  appName: string;
  noun: "app" | "stack";
}): { disabled: boolean; label: string; deleteVolumes: boolean } {
  const deleteVolumes = opts.preview === "ready" && opts.hasData && opts.deleteVolumes;
  return {
    disabled: opts.preview === "loading" || (deleteVolumes && opts.typed !== opts.appName),
    label: deleteVolumes ? `Delete ${opts.noun} and volumes` : `Delete ${opts.noun}`,
    deleteVolumes,
  };
}
