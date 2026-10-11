// What a PR or merged-PR comment renders from, kept in Redis so a rollback in another process rewrites it whole.

import { MAX_GRACE_PERIOD_SECONDS } from "@/lib/deploy/rollback-watch";
import type { PreviewRow, ProductionRow } from "./github-feedback-render";

/** The rollback watch window, plus a sweep interval and its passes. */
export const FEEDBACK_STATE_TTL_MS = MAX_GRACE_PERIOD_SECONDS * 1000 + 5 * 60_000;

export type StoredPr = { sha: string | null; commentId: number | null; rows: Map<string, PreviewRow>; appIds: string[]; orgIds: string[] };
export type StoredMerged = { pr: number | null | undefined; commentId: number | null; rows: Map<string, ProductionRow> };

export type PrPatch = { sha?: string | null; commentId?: number | null; rows?: PreviewRow[]; appIds?: string[]; orgIds?: string[] };
export type MergedPatch = { pr?: number | null; commentId?: number | null; rows?: ProductionRow[] };

export type FeedbackStore = {
  loadPr(key: string): Promise<StoredPr | null>;
  savePr(key: string, patch: PrPatch): Promise<void>;
  removePr(key: string): Promise<void>;
  loadMerged(key: string): Promise<StoredMerged | null>;
  saveMerged(key: string, patch: MergedPatch): Promise<void>;
};

type Hash = Record<string, string>;

/** The subset of ioredis the store uses. */
export type FeedbackRedis = {
  hgetall(key: string): Promise<Hash>;
  del(...keys: string[]): Promise<number>;
  multi(): { hset(key: string, fields: Hash): unknown; pexpire(key: string, ms: number): unknown; exec(): Promise<[Error | null, unknown][] | null> };
};

const prKey = (key: string) => `github:feedback:pr:${key}`;
const mergedKey = (key: string) => `github:feedback:merged:${key}`;

function rowsOf<T>(hash: Hash): Map<string, T> {
  const rows = new Map<string, T>();
  for (const [field, value] of Object.entries(hash)) {
    if (!field.startsWith("row:")) continue;
    try {
      rows.set(field.slice(4), JSON.parse(value) as T);
    } catch { /* a corrupt row is skipped */ }
  }
  return rows;
}

const idOf = (value: string | undefined) => (value && Number.isFinite(Number(value)) ? Number(value) : null);

/** One hash per comment, a field per row, so two processes editing different apps' rows don't overwrite each other. */
export function redisFeedbackStore(redis: FeedbackRedis, ttlMs = FEEDBACK_STATE_TTL_MS): FeedbackStore {
  const write = async (key: string, fields: Hash) => {
    if (Object.keys(fields).length === 0) return;
    const multi = redis.multi();
    multi.hset(key, fields);
    multi.pexpire(key, ttlMs);
    const results = await multi.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  };
  const rowFields = (rows: { app: string }[] | undefined): Hash =>
    Object.fromEntries((rows ?? []).map((r) => [`row:${r.app}`, JSON.stringify(r)]));

  return {
    async loadPr(key) {
      const hash = await redis.hgetall(prKey(key));
      if (!hash || Object.keys(hash).length === 0) return null;
      const fields = Object.keys(hash);
      return {
        sha: hash.sha || null,
        commentId: idOf(hash.commentId),
        rows: rowsOf<PreviewRow>(hash),
        appIds: fields.filter((f) => f.startsWith("app:")).map((f) => f.slice(4)),
        orgIds: fields.filter((f) => f.startsWith("org:")).map((f) => f.slice(4)),
      };
    },
    async savePr(key, patch) {
      await write(prKey(key), {
        ...(patch.sha !== undefined ? { sha: patch.sha ?? "" } : {}),
        ...(patch.commentId !== undefined ? { commentId: String(patch.commentId ?? "") } : {}),
        ...rowFields(patch.rows),
        ...Object.fromEntries((patch.appIds ?? []).map((id) => [`app:${id}`, "1"])),
        ...Object.fromEntries((patch.orgIds ?? []).map((id) => [`org:${id}`, "1"])),
      });
    },
    async removePr(key) {
      await redis.del(prKey(key));
    },
    async loadMerged(key) {
      const hash = await redis.hgetall(mergedKey(key));
      if (!hash || Object.keys(hash).length === 0) return null;
      return {
        pr: hash.pr === undefined ? undefined : idOf(hash.pr),
        commentId: idOf(hash.commentId),
        rows: rowsOf<ProductionRow>(hash),
      };
    },
    async saveMerged(key, patch) {
      await write(mergedKey(key), {
        ...(patch.pr !== undefined ? { pr: String(patch.pr ?? "") } : {}),
        ...(patch.commentId !== undefined ? { commentId: String(patch.commentId ?? "") } : {}),
        ...rowFields(patch.rows),
      });
    },
  };
}
