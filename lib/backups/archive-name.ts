// Archive file names. No server imports: the UI shares the download hint.

export type ArchiveFormat = "tar" | "dump";

/** Marks an archive encrypted under the master key. Older encrypted archives lack it. */
export const ENCRYPTED_SUFFIX = ".enc";

export const DOWNLOAD_HINT =
  "Downloads arrive decrypted. Archives copied straight from storage end in .enc; open them with vardo backup decrypt <in> <out>.";

/** Extension for a new archive, without the leading dot. */
export function archiveExtension(format: ArchiveFormat, encrypted: boolean): string {
  return `${format === "dump" ? "dump.gz" : "tar.gz"}${encrypted ? ENCRYPTED_SUFFIX : ""}`;
}

/** The name with any `.enc` suffix removed. */
export function plainArchiveName(name: string): string {
  return name.endsWith(ENCRYPTED_SUFFIX) ? name.slice(0, -ENCRYPTED_SUFFIX.length) : name;
}

/** Archive format encoded in a storage key, with or without `.enc`. */
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
