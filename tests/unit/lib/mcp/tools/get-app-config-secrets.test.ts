import { describe, it, expect, vi, beforeEach } from "vitest";

// vardo_get_app_config: no ciphertext, compose env masked without env.reveal.

const appFindFirst = vi.fn();
const membershipFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: (...a: unknown[]) => appFindFirst(...a) },
      memberships: { findFirst: (...a: unknown[]) => membershipFindFirst(...a) },
    },
  },
}));

const COMPOSE = "services:\n  db:\n    environment:\n      - POSTGRES_PASSWORD=inline-secret-1\n";
const context = { userId: "u1", organizationId: "org-1", crossOrg: false };

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

async function run(role: string): Promise<string> {
  membershipFindFirst.mockResolvedValue({ role });
  const { registerGetAppConfig } = await import("@/lib/mcp/tools/get-app-config");
  let handler: Handler | undefined;
  registerGetAppConfig(
    { tool: (_n: string, _d: string, _s: unknown, fn: Handler) => { handler = fn; } } as never,
    context as never,
  );
  const res = await handler!({ appId: "a1" });
  return res.content[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
  appFindFirst.mockResolvedValue({
    id: "a1",
    organizationId: "org-1",
    composeContent: COMPOSE,
    envContent: "v1:ciphertext",
    deployments: [{ id: "d1", envSnapshot: "v1:ciphertext", configSnapshot: { composeContent: COMPOSE } }],
  });
});

describe("vardo_get_app_config", () => {
  it("masks compose env and drops ciphertext for a member", async () => {
    const text = await run("member");
    expect(text).not.toContain("inline-secret-1");
    expect(text).not.toContain("ciphertext");
    expect(text).toContain("POSTGRES_PASSWORD");
  });

  it("returns compose as saved for an owner, without ciphertext", async () => {
    const text = await run("owner");
    expect(text).toContain("inline-secret-1");
    expect(text).not.toContain("ciphertext");
  });
});
