// The attention row for an instance with no email provider.

import type { AttentionRow } from "@/lib/ui/attention";

export const EMAIL_SETTINGS_HREF = "/admin/settings/email";

export function emailProviderRows(configured: boolean): AttentionRow[] {
  if (configured) return [];
  return [
    {
      key: "email-provider",
      label: "Email",
      tone: "warning",
      items: [
        {
          id: "email-provider",
          name: "No email provider configured",
          detail: "Notification, invitation and sign-in emails aren't sent.",
          href: EMAIL_SETTINGS_HREF,
          urgent: false,
        },
      ],
      action: { label: "Set up email", href: EMAIL_SETTINGS_HREF },
    },
  ];
}
