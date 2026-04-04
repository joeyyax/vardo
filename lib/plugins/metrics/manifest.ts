import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "metrics-cadvisor",
  name: "Metrics (cAdvisor)",
  description: "Collect container CPU, memory, network, and disk metrics via cAdvisor.",
  version: "1.0.0",
  category: "metrics",

  provides: ["metrics"],
  conflicts: ["metrics-prometheus"],

  requires: {
    redis: true,
    services: [
      {
        name: "cadvisor",
        check: "http",
        default: "http://cadvisor:8080/api/v1.3/docker",
        setting: "cadvisorUrl",
        provisionable: true,
      },
    ],
  },

  ui: {
    settings: [
      {
        key: "cadvisorUrl",
        type: "text",
        label: "cAdvisor URL",
        description: "URL of the cAdvisor API endpoint.",
        default: "http://cadvisor:8080/api/v1.3/docker",
      },
      {
        key: "collectionIntervalMs",
        type: "number",
        label: "Collection interval (ms)",
        description: "How often to collect metrics from cAdvisor.",
        default: 10000,
      },
    ],
    slots: {
      "app.detail.tabs": {
        component: "data-table",
        props: {
          title: "Metrics",
          dataSource: "/api/v1/organizations/{orgId}/apps/{appId}/stats/stream",
        },
      },
      "dashboard.cards": {
        component: "metric-card",
        props: {
          title: "System Resources",
          metric: "cpuUsage",
          icon: "cpu",
        },
      },
    },
  },
};

export default manifest;
