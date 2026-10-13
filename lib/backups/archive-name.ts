// Archive file names. No server imports: the UI shares the download hint.

export type ArchiveFormat = "tar" | "dump";

/** Marks an age-encrypted archive. */
export const ENCRYPTED_SUFFIX = ".age";

export const DOWNLOAD_HINT =
  "Downloads arrive decrypted. Archives copied straight from storage end in .age and open with any age client: age -d -i key.txt <file>. Get key.txt from vardo backup key.";

/** Extension for a new archive, without the leading dot. */
export function archiveExtension(format: ArchiveFormat, encrypted: boolean): string {
  return `${format === "dump" ? "dump.gz" : "tar.gz"}${encrypted ? ENCRYPTED_SUFFIX : ""}`;
}

/** The name with any `.age` suffix removed. */
export function plainArchiveName(name: string): string {
  return name.endsWith(ENCRYPTED_SUFFIX) ? name.slice(0, -ENCRYPTED_SUFFIX.length) : name;
}

/** Archive format encoded in a storage key, with or without `.age`. */
export function formatFromArchiveName(name: string): ArchiveFormat | null {
  const plain = plainArchiveName(name);
  if (plain.endsWith(".dump.gz")) return "dump";
  if (plain.endsWith(".tar.gz")) return "tar";
  return null;
}

/** File name for a decrypted download. */
export function downloadFileName(stem: string, format: ArchiveFormat | null): string {
  return `${stem}.${archiveExtension(format ?? "tar", false)}`;
}
