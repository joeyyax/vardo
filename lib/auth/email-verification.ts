import { getInstanceDisplayName } from "@/lib/system-settings";
import { sendEmail } from "@/lib/email/send";
import { logger } from "@/lib/logger";

const log = logger.child("auth");

/** "node-a · Verify your email", the instance first like every other email. */
export function verifyEmailSubject(instanceName: string | null | undefined): string {
  const instance = instanceName?.trim();
  return instance ? `${instance} · Verify your email` : "Verify your email";
}

/** Better Auth's `emailVerification.sendVerificationEmail`. Throws when the provider refuses. */
export async function sendVerificationEmail({ user, url }: { user: { email: string }; url: string }) {
  if (process.env.NODE_ENV === "development") {
    log.info(`Verification link for ${user.email}: ${url}`);
  }

  const { VerifyEmail } = await import("@/lib/email/templates/verify-email");
  const instanceName = await getInstanceDisplayName().catch(() => null);
  const result = await sendEmail({
    to: user.email,
    subject: verifyEmailSubject(instanceName),
    template: VerifyEmail({ url, email: user.email }),
  });
  if (!result.success) throw new Error(result.error ?? "Couldn't send the verification email");
}
