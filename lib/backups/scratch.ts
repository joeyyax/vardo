// Scratch containers leave no volumes behind: image VOLUMEs become labeled mounts, and teardown removes them by name.

import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

/** Label on every container and volume a scratch helper creates. */
export const SCRATCH_LABEL = "vardo.scratch";

export type ScratchKind = "drill";

export function scratchLabelArgs(kind: ScratchKind): string[] {
  return ["--label", `${SCRATCH_LABEL}=${kind}`];
}

/** One labeled anonymous volume per path; `docker run --rm` and `docker rm -v` both remove them. */
export function scratchMountArgs(kind: ScratchKind, paths: string[]): string[] {
  return paths.flatMap((target) => ["--mount", `type=volume,target=${target},volume-label=${SCRATCH_LABEL}=${kind}`]);
}

/** Paths the image declares with VOLUME. Pulls the image when it isn't local. */
export async function imageVolumePaths(image: string): Promise<string[]> {
  const inspect = () =>
    execFileAsync("docker", ["image", "inspect", "--format", "{{json .Config.Volumes}}", image], {
      env: dockerEnv(),
      timeout: 30_000,
    });
  let stdout: string;
  try {
    stdout = String((await inspect()).stdout);
  } catch {
    await execFileAsync("docker", ["pull", "--quiet", image], { env: dockerEnv(), timeout: 600_000 });
    stdout = String((await inspect()).stdout);
  }
  const parsed = JSON.parse(stdout.trim() || "null") as Record<string, unknown> | null;
  return Object.keys(parsed ?? {});
}

/** Remove a scratch container and every volume it mounted. Never throws. */
export async function removeScratchContainer(container: string): Promise<void> {
  const opts = { env: dockerEnv(), timeout: 60_000 };
  let volumes: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "--format", '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\\n"}}{{end}}{{end}}', container],
      opts,
    );
    volumes = String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // Already gone; `--rm` took its anonymous volumes with it.
  }
  await execFileAsync("docker", ["rm", "-f", "-v", container], opts).catch(() => {});
  if (volumes.length > 0) await execFileAsync("docker", ["volume", "rm", "-f", ...volumes], opts).catch(() => {});
}
