import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({ needsSetup: true }));
vi.mock("@/lib/setup", () => ({ needsSetup: async () => state.needsSetup }));

import {
  SETUP_TOKEN_COOKIE,
  SETUP_TOKEN_HEADER,
  hasSetupToken,
  setupTokenRefusal,
  setupTokenState,
  tokensMatch,
} from "@/lib/setup-token";

const TOKEN = "0123456789abcdef0123456789abcdef";

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/setup/general", { headers });
}

beforeEach(() => {
  state.needsSetup = true;
  vi.stubEnv("SETUP_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("tokensMatch", () => {
  it("accepts the exact token only", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}0`, TOKEN)).toBe(false);
    expect(tokensMatch("", TOKEN)).toBe(false);
    expect(tokensMatch(null, TOKEN)).toBe(false);
  });
});

describe("setupTokenState", () => {
  it("requires the token when SETUP_TOKEN is set", () => {
    expect(setupTokenState()).toEqual({ mode: "required", token: TOKEN });
  });

  it("fails closed in production without a token", () => {
    vi.stubEnv("SETUP_TOKEN", "");
    expect(setupTokenState().mode).toBe("unset");
  });

  it("treats a short token as unset in production", () => {
    vi.stubEnv("SETUP_TOKEN", "short");
    expect(setupTokenState().mode).toBe("unset");
  });

  it("skips the check outside production without a token", () => {
    vi.stubEnv("SETUP_TOKEN", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(setupTokenState().mode).toBe("open");
  });

  it("still requires a set token outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(setupTokenState().mode).toBe("required");
  });
});

describe("hasSetupToken", () => {
  it("refuses a request with no token", () => {
    expect(hasSetupToken(req().headers)).toBe(false);
  });

  it("refuses a wrong header and a wrong cookie", () => {
    expect(hasSetupToken(req({ [SETUP_TOKEN_HEADER]: "nope" }).headers)).toBe(false);
    expect(hasSetupToken(req({ cookie: `${SETUP_TOKEN_COOKIE}=nope` }).headers)).toBe(false);
  });

  it("accepts the right header or cookie", () => {
    expect(hasSetupToken(req({ [SETUP_TOKEN_HEADER]: TOKEN }).headers)).toBe(true);
    expect(hasSetupToken(req({ cookie: `a=b; ${SETUP_TOKEN_COOKIE}=${TOKEN}` }).headers)).toBe(true);
  });

  it("refuses everything in production without SETUP_TOKEN", () => {
    vi.stubEnv("SETUP_TOKEN", "");
    expect(hasSetupToken(req({ [SETUP_TOKEN_HEADER]: "" }).headers)).toBe(false);
    expect(hasSetupToken(req().headers)).toBe(false);
  });
});

describe("setupTokenRefusal", () => {
  it("refuses with 401 when the token is missing", async () => {
    const res = await setupTokenRefusal(req());
    expect(res?.status).toBe(401);
    expect((await res!.json()).code).toBe("setup_token_required");
  });

  it("refuses with 401 when the token is wrong", async () => {
    expect((await setupTokenRefusal(req({ [SETUP_TOKEN_HEADER]: "wrong" })))?.status).toBe(401);
  });

  it("refuses with 503 when production has no token", async () => {
    vi.stubEnv("SETUP_TOKEN", "");
    expect((await setupTokenRefusal(req()))?.status).toBe(503);
  });

  it("passes with the right token", async () => {
    expect(await setupTokenRefusal(req({ [SETUP_TOKEN_HEADER]: TOKEN }))).toBeNull();
  });

  it("stops mattering once setup has latched", async () => {
    state.needsSetup = false;
    expect(await setupTokenRefusal(req())).toBeNull();
  });
});
