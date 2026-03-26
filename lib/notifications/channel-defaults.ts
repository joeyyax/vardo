/**
 * Default enabled state per channel type when a user has no preference row.
 * Email is on by default (primary channel). Slack and webhook require opt-in.
 */
export const CHANNEL_TYPE_DEFAULTS: Record<string, boolean> = {
  email: true,
  slack: false,
  webhook: false,
};
