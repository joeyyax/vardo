import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  needsSetup: false,
  mode: "closed" as "closed" | "open" | "approval",
  invitation: undefined as { id: string } | undefined,
  userCount: 2,
  createDefaultOrg: vi.fn(),
  headers: new Headers(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      invitations: { findFirst: vi.fn(async () => state.invitation) },
    },
    select: () => ({ from: async () => [{ count: String(state.userCount) }] }),
  },
}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("@/lib/setup", () => ({ needsSetup: async () => state.needsSetup }));
vi.mock("@/lib/system-settings", () => ({
  getAuthConfig: async () => ({ registrationMode: state.mode, sessionDurationDays: 7 }),
}));
vi.mock("@/lib/config/auth-methods", () => ({ isAuthMethodEnabled: () => true }));
vi.mock("@/lib/organizations/create-default-org", () => ({
  createDefaultOrgForUser: state.createDefaultOrg,
}));

const { auth } = await import("@/lib/auth");

type Hook = (user: { id: string; email: string; name: string; emailVerified?: boolean }) => Promise<unknown>;
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

  it("lets an invited email through while closed once the mailbox is proven", async () => {
    state.invitation = { id: "inv1" };
    await expect(hooks().before!({ ...newUser, emailVerified: true })).resolves.not.toBe(false);
  });

  it("refuses an unverified signup for an invited email", async () => {
    state.invitation = { id: "inv1" };
    await expect(hooks().before!({ ...newUser, emailVerified: false })).rejects.toThrow(/Registration is closed/);
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

describe("first sign-up needs the setup token", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  beforeEach(() => {
    state.needsSetup = true;
    state.headers = new Headers();
    vi.stubEnv("SETUP_TOKEN", TOKEN);
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses sign-up without the token", async () => {
    await expect(hooks().before!(newUser)).rejects.toThrow(/setup token/);
  });

  it("refuses sign-up with the wrong token", async () => {
    state.headers = new Headers({ cookie: "vardo_setup_token=wrong" });
    await expect(hooks().before!(newUser)).rejects.toThrow(/setup token/);
  });

  it("allows sign-up with the right token", async () => {
    state.headers = new Headers({ cookie: `vardo_setup_token=${TOKEN}` });
    await expect(hooks().before!(newUser)).resolves.toBeUndefined();
  });

  it("ignores the token once setup has closed", async () => {
    state.needsSetup = false;
    state.mode = "open";
    await expect(hooks().before!(newUser)).resolves.toBeUndefined();
  });
});
