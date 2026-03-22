import { execFile } from "child_process";
import { promisify } from "util";
import { assertSafeName } from "@/lib/docker/validate";
import { assertSafeSyncPath } from "@/lib/utils/exec";

const execFileAsync = promisify(execFile);

/**
 * Validate that an image reference contains only safe characters.
 * Image refs can include alphanumerics, dots, dashes, underscores,
 * slashes, colons, and @ (for digests).
 */
function assertSafeImageRef(ref: string): void {
  if (!/^[a-zA-Z0-9._\-/:@]+$/.test(ref)) {
    throw new Error(`Invalid image reference: ${ref}`);
  }
}

/**
 * Simple glob pattern matcher supporting * and ** wildcards.
 * Converts a glob pattern to a regex for matching file paths.
 */
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type FileEntry = { path: string; hash: string; size: number };

/**
 * Run a temp container from the given image and generate a file manifest
 * (path \t md5 \t size) for everything under `mountPath`.
 */
async function getImageManifest(
  imageName: string,
  mountPath: string,
): Promise<FileEntry[]> {
  assertSafeImageRef(imageName);
  // Use find + md5sum to enumerate all regular files under the mount path.
  const script = `find "${mountPath}" -type f -exec sh -c 'for f; do s=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null); h=$(md5sum "$f" 2>/dev/null | cut -d" " -f1); echo "$f\\t$h\\t$s"; done' _ {} +`;

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", imageName, "-c", script],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseManifest(stdout, mountPath);
  } catch {
    // Image might not have the path at all — that's fine
    return [];
  }
}

/**
 * Run a temp container that mounts the named Docker volume and generates
 * the same manifest format.
 */
async function getVolumeManifest(
  volumeDockerName: string,
  mountPath: string,
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
    // Normalise path to be relative
    const rel = fullPath.startsWith(prefix)
      ? fullPath.slice(prefix.length).replace(/^\//, "")
      : fullPath;
    if (rel) entries.push({ path: rel, hash, size });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare the contents of a Docker image at `mountPath` against the
 * contents of a named Docker volume, returning a categorised diff.
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
    getVolumeManifest(volumeDockerName, mountPath),
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

  // Files in the volume that differ from or don't exist in the image
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
      // File exists on disk but not in image
      if (isIgnored(path)) {
        ignored.push(entry);
      } else {
        addedOnDisk.push(entry);
      }
    }
  }

  // Files in the image that are missing from the volume
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

/**
 * Copy specific files from an image into a named Docker volume.
 * Runs a temp container with the volume mounted, then copies files from the
 * image's filesystem into the volume mount.
 */
export async function syncFilesFromImage(
  imageName: string,
  volumeDockerName: string,
  mountPath: string,
  paths: string[],
): Promise<{ synced: string[]; failed: string[] }> {
  if (paths.length === 0) return { synced: [], failed: [] };

  assertSafeName(volumeDockerName);

  // Validate every path before building the shell script. assertSafeSyncPath
  // rejects path traversal (..),  absolute paths, and shell metacharacters so
  // the validated values are safe to interpolate into quoted shell strings.
  for (const p of paths) {
    assertSafeSyncPath(p);
  }

  // Build a script that copies each file from the image path to the volume
  const copyCommands = paths.map((p) => {
    const src = `${mountPath}/${p}`;
    const dst = `/vol/${p}`;
    // Ensure parent directory exists, then copy
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
