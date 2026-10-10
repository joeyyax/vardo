// GitHub push and pull_request deliveries reduced to what deploy matching reads, and the relay form sent to linked peers.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isSafeBranch } from "@/lib/docker/validate";

/** HMAC-SHA256 check of a GitHub delivery against the webhook secret. */
export function verifyGithubSignature(body: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export type PushEvent = {
  kind: "push";
  deliveryId: string | null;
  repoFullName: string;
  branch: string;
  headSha: string | null;
  installationId: number | null;
  pusher?: string | null;
  commitMessage?: string | null;
};

export type PullRequestEvent = {
  kind: "pull_request";
  deliveryId: string | null;
  repoFullName: string;
  action: string;
  prNumber: number;
  branch: string;
  headSha: string | null;
  headRepoFullName: string | null;
  headIsFork: boolean | null;
  author: string | null;
  installationId: number | null;
};

export type GitEvent = PushEvent | PullRequestEvent;

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | undefined => (v && typeof v === "object" ? (v as Json) : undefined);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The event a GitHub delivery describes, or null for other events and incomplete payloads. */
export function eventFromGithub(eventName: string | null, payload: unknown, deliveryId: string | null): GitEvent | null {
  const p = obj(payload);
  if (!p) return null;
  const installationId = obj(p.installation)?.id;
  const install = typeof installationId === "number" ? installationId : null;
  const repoFullName = str(obj(p.repository)?.full_name);

  if (eventName === "push") {
    const branch = str(p.ref)?.replace("refs/heads/", "") ?? null;
    if (!repoFullName || !branch) return null;
    return {
      kind: "push",
      deliveryId,
      repoFullName,
      branch,
      headSha: str(p.after),
      installationId: install,
      pusher: str(obj(p.pusher)?.name) || str(obj(p.sender)?.login),
      commitMessage: str(obj(p.head_commit)?.message),
    };
  }

  if (eventName === "pull_request") {
    const pr = obj(p.pull_request);
    if (!pr || !repoFullName) return null;
    const head = obj(pr.head);
    const headRepo = obj(head?.repo);
    return {
      kind: "pull_request",
      deliveryId,
      repoFullName,
      action: str(p.action) ?? "",
      prNumber: pr.number as number,
      branch: str(head?.ref) ?? "",
      headSha: str(head?.sha),
      headRepoFullName: str(headRepo?.full_name),
      headIsFork: typeof headRepo?.fork === "boolean" ? headRepo.fork : null,
      author: str(obj(pr.user)?.login),
      installationId: install,
    };
  }

  return null;
}

export const WEBHOOK_RELAY_PATH = "/api/v1/mesh/webhook-relay";

/** Raw GitHub bodies larger than this travel without the body. */
export const MAX_RELAY_RAW_BYTES = 256 * 1024;

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LOGIN_RE = /^[A-Za-z0-9-[\]]{1,64}$/;

export function cloneUrlsFor(repoFullName: string): { https: string; ssh: string } {
  return { https: `https://github.com/${repoFullName}.git`, ssh: `git@github.com:${repoFullName}.git` };
}

/** What a relay carries: identifiers only. Never code, credentials or commands. */
export const relayEventSchema = z
  .object({
    v: z.literal(1),
    // Marks a relayed event; the receiver handles it locally and never relays it on.
    relayed: z.literal(true),
    deliveryId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
    event: z.enum(["push", "pull_request"]),
    repoFullName: z.string().regex(REPO_RE),
    cloneUrls: z.object({ https: z.string(), ssh: z.string() }).strict(),
    ref: z.string().max(255),
    branch: z.string().max(255).refine(isSafeBranch, "Invalid branch"),
    headSha: z.string().regex(SHA_RE).nullable(),
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        action: z.string().regex(/^[a-z_]{1,40}$/),
        headRepoFullName: z.string().regex(REPO_RE).nullable(),
        headIsFork: z.boolean().nullable(),
        author: z.string().regex(LOGIN_RE).nullable(),
      })
      .strict()
      .optional(),
    github: z
      .object({
        event: z.enum(["push", "pull_request"]),
        body: z.string().max(MAX_RELAY_RAW_BYTES),
        signature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const urls = cloneUrlsFor(e.repoFullName);
    if (e.cloneUrls.https !== urls.https || e.cloneUrls.ssh !== urls.ssh) {
      ctx.addIssue({ code: "custom", message: "Clone URLs don't match the repository" });
    }
    if (e.event === "push" && e.ref !== `refs/heads/${e.branch}`) {
      ctx.addIssue({ code: "custom", message: "Ref doesn't match the branch" });
    }
    if ((e.event === "pull_request") !== !!e.pullRequest) {
      ctx.addIssue({ code: "custom", message: "Pull request details don't match the event" });
    }
    if (e.github && e.github.event !== e.event) {
      ctx.addIssue({ code: "custom", message: "GitHub body doesn't match the event" });
    }
  });

export type RelayEvent = z.infer<typeof relayEventSchema>;

/** The relay form of an event, with GitHub's body and signature when they're small enough to carry. */
export function toRelayEvent(event: GitEvent & { deliveryId: string }, raw?: { body: string; signature: string }): RelayEvent {
  const base = {
    v: 1 as const,
    relayed: true as const,
    deliveryId: event.deliveryId,
    repoFullName: event.repoFullName,
    cloneUrls: cloneUrlsFor(event.repoFullName),
    branch: event.branch,
    headSha: event.headSha && SHA_RE.test(event.headSha) ? event.headSha : null,
    ...(raw && Buffer.byteLength(raw.body) <= MAX_RELAY_RAW_BYTES
      ? { github: { event: event.kind, body: raw.body, signature: raw.signature } }
      : {}),
  };
  if (event.kind === "push") {
    return { ...base, event: "push", ref: `refs/heads/${event.branch}` };
  }
  return {
    ...base,
    event: "pull_request",
    ref: `refs/pull/${event.prNumber}/head`,
    pullRequest: {
      number: event.prNumber,
      action: event.action,
      headRepoFullName: event.headRepoFullName,
      headIsFork: event.headIsFork,
      author: event.author && LOGIN_RE.test(event.author) ? event.author : null,
    },
  };
}

/** The event a relay describes. Installation ids stay on the sending side. */
export function eventFromRelay(r: RelayEvent): GitEvent {
  if (r.event === "push") {
    return {
      kind: "push",
      deliveryId: r.deliveryId,
      repoFullName: r.repoFullName,
      branch: r.branch,
      headSha: r.headSha,
      installationId: null,
    };
  }
  const pr = r.pullRequest!;
  return {
    kind: "pull_request",
    deliveryId: r.deliveryId,
    repoFullName: r.repoFullName,
    action: pr.action,
    prNumber: pr.number,
    branch: r.branch,
    headSha: r.headSha,
    headRepoFullName: pr.headRepoFullName,
    headIsFork: pr.headIsFork,
    author: pr.author,
    installationId: null,
  };
}

/** Fields that decide what deploys; a relay re-verified against GitHub's body must agree on all of them. */
export function sameDeployTarget(a: GitEvent, b: GitEvent): boolean {
  if (a.kind !== b.kind || a.repoFullName !== b.repoFullName || a.branch !== b.branch) return false;
  if ((a.headSha ?? null) !== (b.headSha ?? null)) return false;
  if (a.kind === "pull_request" && b.kind === "pull_request") {
    return a.prNumber === b.prNumber && a.action === b.action && a.headIsFork === b.headIsFork;
  }
  return true;
}
