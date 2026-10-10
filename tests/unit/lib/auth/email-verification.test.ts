import { describe, it, expect, vi, beforeEach } from "vitest";

const betterAuth = vi.hoisted(() => vi.fn((options: unknown) => ({ options })));
const sendEmail = vi.hoisted(() => vi.fn());
const instanceName = vi.hoisted(() => ({ value: "node-a" as string | null }));

vi.mock("better-auth", () => ({ betterAuth }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: vi.fn(() => ({})) }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => instanceName.value }));

const { auth } = await import("@/lib/auth");
const { sendVerificationEmail, verifyEmailSubject } = await import("@/lib/auth/email-verification");
const { VERIFIED_CALLBACK, VERIFY_EMAIL_HINT } = await import("@/lib/auth/verify-email-paths");

type Options = {
  emailVerification: { sendVerificationEmail: unknown };
  user: { changeEmail: { enabled: boolean } };
};
const options = () => (auth as unknown as { options: Options }).options;

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ success: true });
  instanceName.value = "node-a";
});

describe("email verification config", () => {
  it("sends verification mail through the shared sender", () => {
    expect(options().emailVerification.sendVerificationEmail).toBe(sendVerificationEmail);
  });

  it("allows email changes", () => {
    expect(options().user.changeEmail.enabled).toBe(true);
  });

  it("lands the link on the profile page with a success flag", () => {
    expect(VERIFIED_CALLBACK).toBe("/user/settings/profile?emailVerified=1");
    expect(VERIFY_EMAIL_HINT).toBe("Verify your email in Account settings → Profile");
  });
});

describe("sendVerificationEmail", () => {
  it("prefixes the subject with the instance name", async () => {
    await sendVerificationEmail({ user: { email: "alex@example.com" }, url: "https://host.example.com/v?token=t" });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "alex@example.com", subject: "node-a · Verify your email" }),
    );
  });

  it("drops the prefix when the instance has no name", async () => {
    instanceName.value = null;
    await sendVerificationEmail({ user: { email: "alex@example.com" }, url: "https://host.example.com/v" });
    expect(sendEmail.mock.calls[0][0].subject).toBe("Verify your email");
  });

  it("throws when the provider refuses", async () => {
    sendEmail.mockResolvedValue({ success: false, error: "Resend: 500" });
    await expect(
      sendVerificationEmail({ user: { email: "alex@example.com" }, url: "https://host.example.com/v" }),
    ).rejects.toThrow("Resend: 500");
  });

  it("formats a blank instance name as no prefix", () => {
    expect(verifyEmailSubject("  ")).toBe("Verify your email");
  });
});
