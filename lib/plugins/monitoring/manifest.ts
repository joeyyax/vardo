import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "monitoring",
  name: "Monitoring",
  description: "Health checks, restart loop detection, drift detection, and system service monitoring.",
  version: "1.0.0",
  category: "monitoring",

  provides: ["monitoring"],

  emits: [
    "monitoring.container.unhealthy",
    "monitoring.restart-loop",
    "monitoring.drift-detected",
    "monitoring.auto-rollback",
  ],

  requires: {
    features: ["metrics"],
  },

  hooks: [
    {
      event: "after.deploy.success",
      handler: "start-rollback-monitor",
      priority: 400,
      failMode: "warn",
    },
    {
      event: "after.deploy.success",
      handler: "drift-check",
      priority: 500,
      failMode: "ignore",
    },
  ],

  ui: {
    settings: [
      {
        key: "autoRollbackDefault",
        type: "toggle",
        label: "Auto-rollback by default",
        description: "Enable auto-rollback for new apps.",
        default: false,
      },
      {
        key: "rollbackGracePeriod",
        type: "number",
        label: "Rollback grace period (seconds)",
        description: "How long to monitor after deploy before disabling rollback.",
        default: 60,
      },
      {
        key: "systemHealthInterval",
        type: "number",
        label: "System health check interval (ms)",
        description: "How often to check system service health.",
        default: 60000,
      },
    ],
    slots: {
      "dashboard.cards": {
        component: "metric-card",
        props: {
          title: "System Health",
          metric: "servicesUp",
          icon: "heart-pulse",
        },
      },
      "app.detail.sidebar": {
        component: "status-badge",
        props: {
          label: "Health",
          statusField: "healthStatus",
        },
      },
    },
  },
};

export default manifest;
