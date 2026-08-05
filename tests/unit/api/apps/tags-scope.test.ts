import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/[orgId]/apps/[appId]/tags
// ---------------------------------------------------------------------------
// tagId is caller-supplied. Verifying the app alone is not enough: without an
// org check on the tag, a member can link another organization's tag to their
// own app, which then reads that tag's name and color back out of the app list.

type Predicate =
  | { op: "eq"; col: string; val: unknown }
  | { op: "and"; parts: Predicate[] };

function matches(row: Record<string, unknown>, pred: Predicate | undefined): boolean {
  if (!pred) return true;
  if (pred.op === "and") return pred.parts.every((p) => matches(row, p));
  return row[pred.col] === pred.val;
}

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  and: (...parts: Predicate[]) => ({ op: "and", parts }),
}));

vi.mock("@/lib/db/schema", () => ({
  appTags: { appId: "appId", tagId: "tagId" },
  tags: { id: "id", organizationId: "organizationId" },
}));

const { mockTagFindFirst, mockInsertValues } = vi.hoisted(() => ({
  mockTagFindFirst: vi.fn(),
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { tags: { findFirst: mockTagFindFirst } },
    insert: () => ({ values: mockInsertValues }),
  },
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyAppAccess: vi.fn().mockResolvedValue({ id: "app-1" }),
}));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: never[]) => unknown) => handler,
}));

vi.mock("@/lib/api/error-response", () => ({
  handleRouteError: (error: unknown) => {
    throw error;
  },
  isUniqueViolation: () => false,
}));

import { POST } from "@/app/api/v1/organizations/[orgId]/apps/[appId]/tags/route";

// Two tags with the same shape, owned by different organizations.
const TAG_ROWS = [
  { id: "tag-mine", organizationId: "org-1" },
  { id: "tag-foreign", organizationId: "org-2" },
];

function postTag(tagId: string) {
  const request = new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1/tags", {
    method: "POST",
    body: JSON.stringify({ tagId }),
  });
  return POST(request, { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) });
}

describe("POST /apps/[appId]/tags — tagId scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertValues.mockResolvedValue(undefined);
    mockTagFindFirst.mockImplementation(({ where }: { where?: Predicate }) =>
      Promise.resolve(TAG_ROWS.find((row) => matches(row, where)))
    );
  });

  it("scopes the tag lookup to the org in the path", async () => {
    await postTag("tag-mine");

    const { where } = mockTagFindFirst.mock.calls[0][0];
    expect(where).toEqual({
      op: "and",
      parts: [
        { op: "eq", col: "id", val: "tag-mine" },
        { op: "eq", col: "organizationId", val: "org-1" },
      ],
    });
  });

  it("links a tag owned by the caller's org", async () => {
    const response = await postTag("tag-mine");

    expect(response.status).toBe(201);
    expect(mockInsertValues).toHaveBeenCalledWith({ appId: "app-1", tagId: "tag-mine" });
  });

  it("refuses a tag owned by another org", async () => {
    const response = await postTag("tag-foreign");

    expect(response.status).toBe(404);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("refuses a tag id that matches nothing", async () => {
    const response = await postTag("tag-missing");

    expect(response.status).toBe(404);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});
