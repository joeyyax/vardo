// What a user can see on other instances, read-only. Providers fetch it; the mesh is one of them.

import { z } from "zod";

// Wire shapes. Parsing strips anything else a peer sends, so only these fields ever reach the UI.

export const remoteOrgSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(200),
  role: z.string().max(32),
});

export const remoteAppSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(200),
  displayName: z.string().max(200),
  status: z.string().max(32),
  domains: z.array(z.string().max(253)).max(50),
  lastDeployedAt: z.string().max(40).nullable(),
  attention: z.string().max(200).nullable(),
});

export const remoteProjectSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(200),
  displayName: z.string().max(200),
  apps: z.array(remoteAppSchema).max(500),
});

export const organizationsResponseSchema = z.object({ organizations: z.array(remoteOrgSchema).max(200) });
export const projectsResponseSchema = z.object({ projects: z.array(remoteProjectSchema).max(500) });

export type RemoteOrg = z.infer<typeof remoteOrgSchema>;
export type RemoteApp = z.infer<typeof remoteAppSchema>;
export type RemoteProject = z.infer<typeof remoteProjectSchema>;

export type DirectoryResult<T> =
  | { state: "ok"; data: T }
  | { state: "unreachable" }
  | { state: "refused"; reason: string };

export type DirectoryInstance = {
  id: string;
  name: string;
  status: "online" | "offline";
  /** The instance issues sign-in tickets to this one. */
  signIn: boolean;
  /** The instance answers browse requests from this one. */
  browse: boolean;
};

export interface InstanceDirectoryProvider {
  instances(): Promise<DirectoryInstance[]>;
  organizations(instanceId: string, email: string): Promise<DirectoryResult<RemoteOrg[]>>;
  projects(instanceId: string, email: string, organizationId: string): Promise<DirectoryResult<RemoteProject[]>>;
}
