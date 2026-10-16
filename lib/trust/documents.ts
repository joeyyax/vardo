// Published documents: policy drafts the operator reviews, and the uploaded agreement.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { trustDocuments } from "@/lib/db/schema";
import { POLICY_IDS, POLICY_META, basisHash, generatePolicy, reviewState, type PolicyFacts, type PolicyId, type ReviewState } from "./policies";
import { readPolicyFacts } from "./policy-facts";

export const DPA_ID = "dpa";
export const DPA_MAX_BYTES = 10 * 1024 * 1024;

type DocRow = Omit<typeof trustDocuments.$inferSelect, "file">;

// The file column stays out of every listing: it's read only when someone downloads the agreement.
const LISTED = {
  id: trustDocuments.id,
  reviewedBody: trustDocuments.reviewedBody,
  reviewedAt: trustDocuments.reviewedAt,
  basisHash: trustDocuments.basisHash,
  fileSize: trustDocuments.fileSize,
  updatedAt: trustDocuments.updatedAt,
};

export type PolicyView = {
  id: PolicyId;
  title: string;
  description: string;
  state: ReviewState;
  /** The draft generated from the current settings. */
  draft: string;
  reviewedAt: string | null;
  /** What the public page shows today, if anything. */
  published: string | null;
};

export type DpaView = { uploaded: boolean; size: number | null; uploadedAt: string | null; published: boolean; reviewedAt: string | null };

async function rows(): Promise<Map<string, DocRow>> {
  const all = await db.select(LISTED).from(trustDocuments);
  return new Map(all.map((r) => [r.id, r]));
}

export function policyViews(facts: PolicyFacts, docs: Map<string, Pick<DocRow, "reviewedAt" | "reviewedBody" | "basisHash">>): PolicyView[] {
  return POLICY_IDS.map((id) => {
    const doc = docs.get(id) ?? null;
    return {
      id,
      ...POLICY_META[id],
      state: reviewState(doc, basisHash(id, facts)),
      draft: generatePolicy(id, facts),
      reviewedAt: doc?.reviewedAt?.toISOString() ?? null,
      published: doc?.reviewedAt ? (doc.reviewedBody ?? null) : null,
    };
  });
}

/** Policies waiting on the operator: never reviewed, or the settings behind them changed. */
export function policyReviews(policies: PolicyView[]): { id: string; title: string; detail: string; href: string; action: string }[] {
  return policies.flatMap((p) => {
    if (p.state === "reviewed") return [];
    const detail = p.state === "draft" ? "Generated from your settings. It stays off the public page until you review it." : "Your settings changed. The public page keeps the last reviewed version until you review this one.";
    return [{ id: `policy-${p.id}`, title: p.state === "draft" ? `Review the ${p.title.toLowerCase()}` : `Review the ${p.title.toLowerCase()} again`, detail, href: "#documents", action: "Review" }];
  });
}

export async function readDocuments(): Promise<{ policies: PolicyView[]; dpa: DpaView }> {
  const [facts, docs] = await Promise.all([readPolicyFacts(), rows()]);
  const dpa = docs.get(DPA_ID);
  return {
    policies: policyViews(facts, docs),
    dpa: {
      uploaded: !!dpa?.fileSize,
      size: dpa?.fileSize ?? null,
      uploadedAt: dpa?.updatedAt?.toISOString() ?? null,
      published: !!dpa?.reviewedAt,
      reviewedAt: dpa?.reviewedAt?.toISOString() ?? null,
    },
  };
}

/** Publishes the text the operator reviewed against the settings as they are now. */
export async function reviewPolicy(id: PolicyId, body: string): Promise<void> {
  const facts = await readPolicyFacts();
  const set = { reviewedBody: body, reviewedAt: new Date(), basisHash: basisHash(id, facts), updatedAt: new Date() };
  await db.insert(trustDocuments).values({ id, ...set }).onConflictDoUpdate({ target: trustDocuments.id, set });
}

/** Takes a policy off the public page. */
export async function unpublishPolicy(id: PolicyId): Promise<void> {
  await db.update(trustDocuments).set({ reviewedAt: null, reviewedBody: null, basisHash: null, updatedAt: new Date() }).where(eq(trustDocuments.id, id));
}

/** Stores a new agreement. It stays private until the operator publishes it. */
export async function saveDpa(file: Buffer): Promise<void> {
  const set = { file, fileSize: file.length, reviewedAt: null, updatedAt: new Date() };
  await db.insert(trustDocuments).values({ id: DPA_ID, ...set }).onConflictDoUpdate({ target: trustDocuments.id, set });
}

export async function publishDpa(): Promise<boolean> {
  const updated = await db.update(trustDocuments).set({ reviewedAt: new Date(), updatedAt: new Date() }).where(eq(trustDocuments.id, DPA_ID)).returning({ size: trustDocuments.fileSize });
  return !!updated[0]?.size;
}

export async function unpublishDpa(): Promise<void> {
  await db.update(trustDocuments).set({ reviewedAt: null, updatedAt: new Date() }).where(eq(trustDocuments.id, DPA_ID));
}

export async function removeDpa(): Promise<void> {
  await db.delete(trustDocuments).where(eq(trustDocuments.id, DPA_ID));
}

/** The agreement's bytes. Pass publishedOnly for the public route. */
export async function readDpaFile(publishedOnly: boolean): Promise<Buffer | null> {
  const row = (await db.select({ file: trustDocuments.file, reviewedAt: trustDocuments.reviewedAt }).from(trustDocuments).where(eq(trustDocuments.id, DPA_ID)))[0];
  if (!row?.file || (publishedOnly && !row.reviewedAt)) return null;
  return row.file;
}

/** The inputs the public filter reads. */
export async function readPublicDocuments(): Promise<{
  policies: { id: string; title: string; reviewedBody: string | null; reviewedAt: Date | null }[];
  dpa: { hasFile: boolean; reviewedAt: Date | null } | null;
}> {
  const docs = await rows();
  const dpa = docs.get(DPA_ID);
  return {
    policies: POLICY_IDS.map((id) => ({ id, title: POLICY_META[id].title, reviewedBody: docs.get(id)?.reviewedBody ?? null, reviewedAt: docs.get(id)?.reviewedAt ?? null })),
    dpa: dpa ? { hasFile: !!dpa.fileSize, reviewedAt: dpa.reviewedAt } : null,
  };
}
