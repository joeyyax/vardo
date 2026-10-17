import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "./docker-env";
import { COMPOSE_QUERY_TIMEOUT } from "./constants";

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;

/** Total size of these local images, or null when docker can't say for every one. */
export async function imagesBytes(images: string[], exec: Exec = execFileAsync as unknown as Exec): Promise<number | null> {
  if (images.length === 0) return null;
  try {
    const { stdout } = await exec("docker", ["image", "inspect", "--format", "{{.Size}}", ...images], { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT });
    const sizes = String(stdout).trim().split("\n").map(Number);
    if (sizes.length !== images.length || sizes.some((n) => !Number.isFinite(n) || n < 0)) return null;
    return sizes.reduce((a, b) => a + b, 0);
  } catch {
    return null;
  }
}
