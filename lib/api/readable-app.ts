import { maskComposeEnv } from "@/lib/docker/compose-mask";
import { maskGitUrl } from "@/lib/api/git-fields";

// App and deployment rows for read responses: no ciphertext, compose env masked without `env.reveal`.

export function readableDeployment<D extends object>(deployment: D, reveal: boolean): Omit<D, "envSnapshot"> {
  const { envSnapshot: _envSnapshot, ...rest } = deployment as D & { envSnapshot?: unknown };
  const snapshot = (rest as { configSnapshot?: unknown }).configSnapshot as
    | { composeContent?: string | null }
    | null
    | undefined;
  if (reveal || !snapshot || typeof snapshot.composeContent !== "string") return rest;
  return { ...rest, configSnapshot: { ...snapshot, composeContent: maskComposeEnv(snapshot.composeContent) } };
}

type ReadableAppInput = {
  envContent?: unknown;
  gitUrl?: string | null;
  gitCredentials?: string | null;
  composeContent?: string | null;
  deployments?: object[];
};

type ReadableApp<A extends ReadableAppInput> = Omit<A, "envContent" | "gitCredentials" | "deployments"> &
  (A extends { deployments: (infer D extends object)[] }
    ? { deployments: Omit<D, "envSnapshot">[] }
    : unknown);

export function readableApp<A extends ReadableAppInput>(app: A, reveal: boolean): ReadableApp<A> {
  const { envContent: _envContent, gitCredentials, ...rest } = app;
  const out: Record<string, unknown> = { ...rest };
  if (!reveal && typeof app.composeContent === "string") out.composeContent = maskComposeEnv(app.composeContent);
  // Credentials in a git URL are never shown, whoever reads it.
  if (typeof app.gitUrl === "string") out.gitUrl = maskGitUrl(app.gitUrl, !!gitCredentials);
  if (Array.isArray(app.deployments)) out.deployments = app.deployments.map((d) => readableDeployment(d, reveal));
  return out as ReadableApp<A>;
}
