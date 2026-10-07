import { assertSafeName, assertSafeMountPath } from "@/lib/docker/validate";
import { assertSafeSyncPath } from "@/lib/utils/exec";
import { execFileAsync } from "@/lib/utils/exec";

/** Throws unless the image ref is alphanumerics, `.`, `-`, `_`, `/`, `:` or `@`. */
function assertSafeImageRef(ref: string): void {
  if (!/^[a-zA-Z0-9._\-/:@]+$/.test(ref)) {
    throw new Error(`Invalid image reference: ${ref}`);
  }
}

/** Glob match supporting `*`, `**` and `?`. */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const regex = globToRegex(pattern);
    if (regex.test(filePath)) return true;
  }
  return false;
}

function globToRegex(glob: string): RegExp {
  let result = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches any path segment(s)
        if (glob[i + 2] === "/") {
          result += "(?:.+/)?";
          i += 3;
        } else {
          result += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        result += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      result += "[^/]";
      i++;
    } else if (c === "." || c === "(" || c === ")" || c === "+" || c === "^" || c === "$" || c === "{" || c === "}" || c === "|" || c === "\\") {
      result += "\\" + c;
      i++;
    } else {
      result += c;
      i++;
    }
  }
  result += "$";
  return new RegExp(result);
}

export type DiffEntry = {
  path: string;
  imageHash?: string;
  volumeHash?: string;
  sizeBytes: number;
};

export type VolumeDiffResult = {
  modified: DiffEntry[];
  addedOnDisk: DiffEntry[];
  missingFromDisk: DiffEntry[];
  ignored: DiffEntry[];
};

type FileEntry = { path: string; hash: string; size: number };

/** File manifest (path, md5, size) of `mountPath` inside the image. */
async function getImageManifest(
  imageName: string,
  mountPath: string,
): Promise<FileEntry[]> {
  assertSafeImageRef(imageName);
  assertSafeMountPath(mountPath);
  const script = `find "${mountPath}" -type f -exec sh -c 'for f; do s=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null); h=$(md5sum "$f" 2>/dev/null | cut -d" " -f1); echo "$f\\t$h\\t$s"; done' _ {} +`;

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", imageName, "-c", script],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseManifest(stdout, mountPath);
  } catch {
    // Image may not have the path.
    return [];
  }
}

/** File manifest of the named Docker volume. */
async function getVolumeManifest(
  volumeDockerName: string,
): Promise<FileEntry[]> {
  assertSafeName(volumeDockerName);
  const script = `find /vol -type f -exec sh -c 'for f; do s=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null); h=$(md5sum "$f" 2>/dev/null | cut -d" " -f1); echo "$f\\t$h\\t$s"; done' _ {} +`;

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${volumeDockerName}:/vol`, "alpine", "sh", "-c", script],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseManifest(stdout, "/vol");
  } catch {
    return [];
  }
}

function parseManifest(raw: string, prefix: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const fullPath = parts[0];
    const hash = parts[1];
    const size = parseInt(parts[2]) || 0;
    const rel = fullPath.startsWith(prefix)
      ? fullPath.slice(prefix.length).replace(/^\//, "")
      : fullPath;
    if (rel) entries.push({ path: rel, hash, size });
  }
  return entries;
}

/**
 * Diff an image's files at `mountPath` against a named Docker volume.
 *
 * @param imageName    Full image reference (e.g. "postgres:16")
 * @param volumeDockerName  Docker volume name (e.g. "myapp-production-blue_data")
 * @param mountPath    Container mount path (e.g. "/var/lib/postgresql/data")
 * @param ignorePatterns  Glob patterns to filter out (e.g. ["uploads/**", "cache/**"])
 */
export async function computeVolumeDiff(
  imageName: string,
  volumeDockerName: string,
  mountPath: string,
  ignorePatterns: string[] = [],
): Promise<VolumeDiffResult> {
  const [imageFiles, volumeFiles] = await Promise.all([
    getImageManifest(imageName, mountPath),
    getVolumeManifest(volumeDockerName),
  ]);

  const imageMap = new Map(imageFiles.map((f) => [f.path, f]));
  const volumeMap = new Map(volumeFiles.map((f) => [f.path, f]));

  const isIgnored = ignorePatterns.length > 0
    ? (path: string) => matchesAnyPattern(path, ignorePatterns)
    : () => false;

  const modified: DiffEntry[] = [];
  const addedOnDisk: DiffEntry[] = [];
  const missingFromDisk: DiffEntry[] = [];
  const ignored: DiffEntry[] = [];

  for (const [path, volFile] of volumeMap) {
    const entry: DiffEntry = {
      path,
      volumeHash: volFile.hash,
      sizeBytes: volFile.size,
    };

    const imgFile = imageMap.get(path);
    if (imgFile) {
      entry.imageHash = imgFile.hash;
      if (imgFile.hash !== volFile.hash) {
        if (isIgnored(path)) {
          ignored.push(entry);
        } else {
          modified.push(entry);
        }
      }
    } else {
      if (isIgnored(path)) {
        ignored.push(entry);
      } else {
        addedOnDisk.push(entry);
      }
    }
  }

  for (const [path, imgFile] of imageMap) {
    if (!volumeMap.has(path)) {
      const entry: DiffEntry = {
        path,
        imageHash: imgFile.hash,
        sizeBytes: imgFile.size,
      };
      if (isIgnored(path)) {
        ignored.push(entry);
      } else {
        missingFromDisk.push(entry);
      }
    }
  }

  return { modified, addedOnDisk, missingFromDisk, ignored };
}

/** Copy files from an image into a named Docker volume. */
export async function syncFilesFromImage(
  imageName: string,
  volumeDockerName: string,
  mountPath: string,
  paths: string[],
): Promise<{ synced: string[]; failed: string[] }> {
  if (paths.length === 0) return { synced: [], failed: [] };

  assertSafeName(volumeDockerName);
  assertSafeMountPath(mountPath);

  // Paths are interpolated into a shell script; validate every one first.
  for (const p of paths) {
    assertSafeSyncPath(p);
  }

  const copyCommands = paths.map((p) => {
    const src = `${mountPath}/${p}`;
    const dst = `/vol/${p}`;
    return `mkdir -p "$(dirname "${dst}")" && cp -f "${src}" "${dst}" && echo "OK:${p}" || echo "FAIL:${p}"`;
  });

  const script = copyCommands.join(" ; ");

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${volumeDockerName}:/vol`, imageName, "sh", "-c", script],
      { timeout: 60000 },
    );

    const synced: string[] = [];
    const failed: string[] = [];
    for (const line of stdout.trim().split("\n")) {
      if (line.startsWith("OK:")) synced.push(line.slice(3));
      else if (line.startsWith("FAIL:")) failed.push(line.slice(5));
    }
    return { synced, failed };
  } catch {
    return { synced: [], failed: paths };
  }
}
