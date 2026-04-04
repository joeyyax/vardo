import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "security-scanner",
  name: "Security Scanner",
  description: "Scan deployed apps for exposed files, secrets, and security misconfigurations.",
  version: "1.0.0",
  category: "security",

  provides: ["security-scanning"],

  emits: [
    "before.security.scan",
    "after.security.scan",
    "security.finding.critical",
  ],

  hooks: [
    {
      event: "after.deploy.success",
      handler: "run-scan",
      priority: 300,
      failMode: "warn",
    },
  ],

  ui: {
    settings: [
      {
        key: "scanOnDeploy",
        type: "toggle",
        label: "Scan on every deploy",
        description: "Run a security scan after each successful deployment.",
        default: true,
      },
      {
        key: "failOnCritical",
        type: "toggle",
        label: "Block deploys with critical findings",
        description: "Register a before.deploy.start hook that blocks deploys with critical security findings.",
        default: false,
      },
    ],
    slots: {
      "app.detail.tabs": {
        component: "data-table",
        props: {
          title: "Security",
          dataSource: "/api/v1/plugins/security-scanner/findings",
        },
      },
      "app.detail.sidebar": {
        component: "status-badge",
        props: {
          label: "Security",
          statusField: "lastScanStatus",
        },
      },
    },
    nav: [
      {
        label: "Security",
        icon: "shield",
        path: "/security",
        scope: "app",
      },
    ],
  },
};

export default manifest;
