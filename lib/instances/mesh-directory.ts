// Instance directory over the mesh: one signed call per question, cached briefly in memory, never stored.

import { and, eq, or } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { MeshClientError, meshSignedPost } from "@/lib/mesh/client";
import { INSTANCE_BROWSE_PATH, type BrowseRequest } from "./browse";
import {
  organizationsResponseSchema,
  projectsResponseSchema,
  type DirectoryInstance,
  type DirectoryResult,
  type InstanceDirectoryProvider,
  type RemoteOrg,
  type RemoteProject,
} from "./directory";

export const CACHE_TTL_MS = 20_000;
const CACHE_MAX = 500;

type Post = (peerId: string, path: string, payload: unknown, opts: { timeoutMs: number; probeMs: number }) => Promise<{ data: unknown }>;

type BrowsePeerRow = { id: string; name: string; status: string; peerAcceptsInstanceBrowse: boolean };

type Deps = {
  post: Post;
  findPeer(peerId: string): Promise<BrowsePeerRow | null>;
  listPeers(): Promise<(BrowsePeerRow & { peerAcceptsInstanceSignin: boolean })[]>;
  now(): number;
};

const dbDeps: Deps = {
  post: (peerId, path, payload, opts) => meshSignedPost(peerId, path, payload, opts),
  async findPeer(peerId) {
    const row = await db.query.meshPeers.findFirst({
      where: and(eq(meshPeers.id, peerId), eq(meshPeers.connectionType, "direct")),
      columns: { id: true, name: true, status: true, peerAcceptsInstanceBrowse: true },
    });
    return row ?? null;
  },
  listPeers() {
    return db.query.meshPeers.findMany({
      where: and(
        eq(meshPeers.connectionType, "direct"),
        or(eq(meshPeers.peerAcceptsInstanceSignin, true), eq(meshPeers.peerAcceptsInstanceBrowse, true)),
      ),
      columns: { id: true, name: true, status: true, peerAcceptsInstanceSignin: true, peerAcceptsInstanceBrowse: true },
      orderBy: (p, { asc }) => [asc(p.name)],
    });
  },
  now: () => Date.now(),
};

export function meshDirectory(overrides: Partial<Deps> = {}): InstanceDirectoryProvider & { clearCache(): void } {
  const deps = { ...dbDeps, ...overrides };
  const cache = new Map<string, { expires: number; value: DirectoryResult<unknown> }>();

  async function ask<T>(
    peerId: string,
    request: BrowseRequest,
    schema: z.ZodType<T>,
  ): Promise<DirectoryResult<T>> {
    const key = JSON.stringify([peerId, request]);
    const hit = cache.get(key);
    if (hit && hit.expires > deps.now()) return hit.value as DirectoryResult<T>;

    const result = await fetchOnce(peerId, request, schema);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { expires: deps.now() + CACHE_TTL_MS, value: result });
    return result;
  }

  async function fetchOnce<T>(peerId: string, request: BrowseRequest, schema: z.ZodType<T>): Promise<DirectoryResult<T>> {
    const peer = await deps.findPeer(peerId);
    if (!peer) return { state: "refused", reason: "No linked instance with that id" };
    if (!peer.peerAcceptsInstanceBrowse) {
      return { state: "refused", reason: `${peer.name} doesn't share its projects with this instance` };
    }
    if (peer.status !== "online") return { state: "unreachable" };

    try {
      const { data } = await deps.post(peerId, INSTANCE_BROWSE_PATH, request, { timeoutMs: 5_000, probeMs: 1_500 });
      const parsed = schema.safeParse(data);
      return parsed.success ? { state: "ok", data: parsed.data } : { state: "unreachable" };
    } catch (err) {
      if (err instanceof MeshClientError && err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        return { state: "refused", reason: err.message };
      }
      return { state: "unreachable" };
    }
  }

  return {
    async instances(): Promise<DirectoryInstance[]> {
      const rows = await deps.listPeers();
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status === "online" ? "online" : "offline",
        signIn: p.peerAcceptsInstanceSignin,
        browse: p.peerAcceptsInstanceBrowse,
      }));
    },
    async organizations(peerId, email): Promise<DirectoryResult<RemoteOrg[]>> {
      const res = await ask(peerId, { kind: "organizations", email }, organizationsResponseSchema);
      return res.state === "ok" ? { state: "ok", data: res.data.organizations } : res;
    },
    async projects(peerId, email, organizationId): Promise<DirectoryResult<RemoteProject[]>> {
      const res = await ask(peerId, { kind: "projects", email, organizationId }, projectsResponseSchema);
      return res.state === "ok" ? { state: "ok", data: res.data.projects } : res;
    },
    clearCache: () => cache.clear(),
  };
}

/** The directory the console reads. One cache per process. */
export const instanceDirectory = meshDirectory();
