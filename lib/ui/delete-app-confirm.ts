export type PreviewStatus = "loading" | "ready" | "failed";

/**
 * The delete dialog's confirm button. Blocked until the volume check settles,
 * so nobody confirms without having seen the list. Volumes are only destroyed
 * when there are some, the box is checked and the name is typed.
 */
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
