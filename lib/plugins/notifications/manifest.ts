import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "notifications",
  name: "Notifications",
  description: "Send alerts via email, webhook, and Slack when events occur.",
  version: "1.0.0",
  builtIn: true,
  category: "notifications",
  icon: "https://cdn.simpleicons.org/maildotru",

  provides: ["notifications"],

  requires: {
    redis: true,
  },

  consumers: [
    {
      stream: "stream:events:*",
      group: "notifications",
      handler: "dispatch",
    },
  ],

  ui: {
    settings: [
      {
        key: "defaultNotifyOnDeploy",
        type: "toggle",
        label: "Notify on deploy by default",
        description: "New notification channels will subscribe to deploy events by default.",
        default: true,
      },
    ],
    slots: {
      "settings.sections": {
        component: "form-section",
        props: {
          title: "Notification Channels",
          description: "Configure email, webhook, and Slack notifications.",
          dataSource: "/api/v1/organizations/{orgId}/notifications",
        },
      },
    },
    nav: [
      {
        label: "Notifications",
        icon: "bell",
        path: "/notifications",
        scope: "org",
      },
    ],
  },
};

export default manifest;
