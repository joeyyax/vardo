import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "domain-monitoring",
  name: "Domain Monitoring",
  description: "Periodic DNS health checks and SSL certificate expiration monitoring for all configured domains.",
  version: "1.0.0",
  builtIn: true,
  category: "monitoring",
  icon: "https://cdn.simpleicons.org/cloudflare",

  provides: ["domain-monitoring"],

  requires: {
    features: ["ssl"],
  },

  ui: {
    slots: {
      "admin.sections": {
        component: "data-table",
        props: {
          title: "Domain Health",
          dataSource: "/api/v1/admin/domains/health",
        },
      },
    },
  },
};

export default manifest;
