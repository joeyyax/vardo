import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  needsSetup: false,
  mode: "closed" as "closed" | "open" | "approval",
  invitation: undefined as { id: string } | undefined,
  userCount: 2,
  createDefaultOrg: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      invitations: { findFirst: vi.fn(async () => state.invitation) },
    },
    select: () => ({ from: async () => [{ count: String(state.userCount) }] }),
  },
}));
vi.mock("@/lib/setup", () => ({ needsSetup: async () => state.needsSetup }));
vi.mock("@/lib/system-settings", () => ({
  getAuthConfig: async () => ({ registrationMode: state.mode, sessionDurationDays: 7 }),
}));
vi.mock("@/lib/config/auth-methods", () => ({ isAuthMethodEnabled: () => true }));
vi.mock("@/lib/organizations/create-default-org", () => ({
  createDefaultOrgForUser: state.createDefaultOrg,
}));

const { auth } = await import("@/lib/auth");

type Hook = (user: { id: string; email: string; name: string }) => Promise<unknown>;
const hooks = () =>
  (auth.options.databaseHooks?.user?.create ?? {}) as { before?: Hook; after?: Hook };

const newUser = { id: "u2", email: "stranger@example.com", name: "Stranger" };

beforeEach(() => {
  state.needsSetup = false;
  state.mode = "closed";
  state.invitation = undefined;
  state.userCount = 2;
  state.createDefaultOrg.mockReset();
});

describe("user creation respects registrationMode", () => {
  it("refuses a stranger while registration is closed", async () => {
    const before = hooks().before;
    expect(before).toBeTypeOf("function");
    await expect(before!(newUser)).rejects.toThrow(/Registration is closed/);
  });

  it("refuses under approval, which has no queue", async () => {
    state.mode = "approval";
    await expect(hooks().before!(newUser)).rejects.toThrow(/Registration is closed/);
  });

  it("lets the first user through during setup", async () => {
    state.needsSetup = true;
    await expect(hooks().before!(newUser)).resolves.not.toBe(false);
  });

  it("lets an invited email through while closed", async () => {
    state.invitation = { id: "inv1" };
    await expect(hooks().before!(newUser)).resolves.not.toBe(false);
  });

  it("lets anyone through when open", async () => {
    state.mode = "open";
    await expect(hooks().before!(newUser)).resolves.not.toBe(false);
  });
});

describe("signup org creation", () => {
  it("gives an invitee no org of their own while closed", async () => {
    await hooks().after!(newUser);
    expect(state.createDefaultOrg).not.toHaveBeenCalled();
  });

  it("gives the first user an org", async () => {
    state.userCount = 1;
    await hooks().after!(newUser);
    expect(state.createDefaultOrg).toHaveBeenCalledWith("u2", "Stranger", "stranger@example.com");
  });

  it("gives open-registration signups an org", async () => {
    state.mode = "open";
    await hooks().after!(newUser);
    expect(state.createDefaultOrg).toHaveBeenCalled();
  });
});
