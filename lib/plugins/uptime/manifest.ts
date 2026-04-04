import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "uptime",
  name: "Uptime Monitoring",
  description: "Monitor endpoint availability via Uptime Kuma.",
  version: "1.0.0",
  category: "monitoring",
  icon: "https://cdn.simpleicons.org/uptimekuma",

  provides: ["uptime-monitoring"],

  requires: {
    services: [
      {
        name: "uptime-kuma",
        check: "http",
        default: "http://uptime-kuma:3001",
        setting: "uptimeKumaUrl",
        provisionable: true,
        templateName: "uptime-kuma",
      },
    ],
  },

  ui: {
    settings: [
      {
        key: "uptimeKumaUrl",
        type: "text",
        label: "Uptime Kuma URL",
        description: "URL of your Uptime Kuma instance.",
        default: "http://uptime-kuma:3001",
      },
      {
        key: "apiToken",
        type: "password",
        label: "API Token",
        description: "API token for Uptime Kuma authentication.",
      },
    ],
    slots: {
      "dashboard.cards": {
        component: "metric-card",
        props: {
          title: "Uptime Status",
          metric: "uptime",
          icon: "activity",
        },
      },
    },
  },
};

export default manifest;
