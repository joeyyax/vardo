import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "logging",
  name: "Log Aggregation",
  description: "Centralized logging via Loki and Grafana dashboards.",
  version: "1.0.0",
  category: "monitoring",

  provides: ["logging"],

  requires: {
    services: [
      {
        name: "loki",
        check: "http",
        default: "http://loki:3100/ready",
        setting: "lokiUrl",
        provisionable: true,
      },
    ],
  },

  ui: {
    settings: [
      {
        key: "lokiUrl",
        type: "text",
        label: "Loki URL",
        description: "URL of your Loki log aggregation endpoint.",
        default: "http://loki:3100",
      },
      {
        key: "grafanaUrl",
        type: "text",
        label: "Grafana URL",
        description: "URL of your Grafana instance for log dashboards.",
      },
    ],
  },
};

export default manifest;
