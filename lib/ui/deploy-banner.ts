// App header failure banner. "recovered" is a failed deploy the previous release kept serving through.

export type DeployFailureVariant = "crashed" | "recovered";

type DeployLike = { status: string };

export type DeployFailureBanner<T> = { variant: DeployFailureVariant; deployment: T };

/** Deployments must be newest first. */
export function deployFailureBanner<T extends DeployLike>(
  appStatus: string,
  deployments: T[],
): DeployFailureBanner<T> | null {
  if (appStatus === "error") {
    const failed = deployments.find((d) => d.status === "failed");
    return failed ? { variant: "crashed", deployment: failed } : null;
  }

  const latest = deployments[0];
  if (appStatus === "active" && latest?.status === "failed") {
    return { variant: "recovered", deployment: latest };
  }

  return null;
}
