import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEmailProviderConfig } from "@/lib/system-settings";
import { MASK_SENTINEL } from "@/lib/mask-secrets";
import { EMAIL_PROVIDERS, emailSettingsSchema, readEmailSettings, saveEmailSettings } from "@/lib/email/provider-settings";
import { ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";
import type { McpAuthContext } from "../auth";
import { canAdminInstance } from "../scope";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

const SECRETS = ["smtpPass", "apiKey", "webhookSecret"] as const;

/** Instance email provider tools. Registered only for a token with the admin scope. */
export function registerEmailSettingsTools(server: McpServer, context: McpAuthContext) {
  if (!context.adminScope) return;

  server.tool(
    "vardo_get_email_settings",
    "Read the instance's email provider settings. Secrets come back masked. Needs a token with the admin scope.",
    {},
    async () => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);
      return text(await readEmailSettings());
    },
  );

  server.tool(
    "vardo_update_email_settings",
    "Update the instance's email provider. Omitted fields, secrets included, keep their stored values; secrets are write-only. Needs a token with the admin scope.",
    {
      provider: z.enum(EMAIL_PROVIDERS).optional(),
      fromEmail: z.string().optional().describe("Sender address"),
      fromName: z.string().optional(),
      apiKey: z.string().optional().describe("Mailpace, Resend, Postmark or Pouch API key"),
      smtpHost: z.string().optional(),
      smtpPort: z.number().int().positive().optional(),
      smtpUser: z.string().optional(),
      smtpPass: z.string().optional(),
      baseUrl: z.string().optional().describe("Pouch only: API base URL"),
      webhookSecret: z.string().optional().describe("Pouch only: webhook signing secret"),
    },
    async (input) => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);

      const stored = (await getEmailProviderConfig()) as Record<string, unknown> | null;
      const given: Record<string, unknown> = input;
      const merged: Record<string, unknown> = {};
      for (const key of Object.keys(emailSettingsSchema.shape)) {
        const value = given[key] ?? (SECRETS.includes(key as (typeof SECRETS)[number]) ? MASK_SENTINEL : stored?.[key]);
        if (value !== undefined && value !== null) merged[key] = value;
      }

      const parsed = emailSettingsSchema.safeParse(merged);
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");
      const error = await saveEmailSettings(parsed.data);
      if (error) return failure(error);
      return text(await readEmailSettings());
    },
  );
}
