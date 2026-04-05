import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "digest",
  name: "Weekly Digest",
  description: "Weekly summary email with deploy stats, backup status, cron failures, and system health.",
  version: "1.0.0",
  builtIn: true,
  category: "notifications",
  icon: "https://cdn.simpleicons.org/minutemailer",

  provides: ["digest"],

  requires: {
    features: ["cron", "notifications", "metrics"],
  },

  ui: {
    settings: [
      {
        key: "enabled",
        type: "toggle",
        label: "Send weekly digest",
        description: "Email a weekly summary to org admins.",
        default: true,
      },
      {
        key: "dayOfWeek",
        type: "select",
        label: "Send on",
        default: "monday",
        options: [
          { label: "Monday", value: "monday" },
          { label: "Friday", value: "friday" },
          { label: "Sunday", value: "sunday" },
        ],
      },
    ],
  },
};

export default manifest;
