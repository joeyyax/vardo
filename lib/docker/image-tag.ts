/** Image reference for a deployment's build. A tag can't start with `-` or `.`, which nanoid ids can. */
export function deploymentImageName(appName: string, deploymentId: string): string {
  return `host/${appName}:${deploymentId.slice(0, 8).replace(/^[-.]/, "_")}`;
}
