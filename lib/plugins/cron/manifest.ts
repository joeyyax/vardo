import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "cron",
  name: "Cron Jobs",
  description: "Scheduled task execution for apps. Sync from host.toml, templates, or manual configuration.",
  version: "1.0.0",
  category: "scheduling",

  provides: ["cron"],

  ui: {
    slots: {
      "app.detail.tabs": {
        component: "data-table",
        props: {
          title: "Cron Jobs",
          dataSource: "/api/v1/organizations/{orgId}/apps/{appId}/cron",
        },
      },
    },
  },
};

export default manifest;
