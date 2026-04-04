import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "backups",
  name: "Backups",
  description: "Scheduled backups with S3, B2, SSH, and local storage adapters. GFS retention.",
  version: "1.0.0",
  category: "backups",
  icon: "https://cdn.simpleicons.org/backblaze",

  provides: ["backups"],

  requires: {
    redis: true,
  },

  emits: [
    "before.backup.run",
    "after.backup.success",
    "after.backup.failed",
    "before.backup.restore",
    "after.backup.restore",
  ],

  hooks: [
    {
      event: "after.deploy.success",
      handler: "ensure-auto-backup",
      priority: 200,
      failMode: "warn",
    },
  ],

  ui: {
    settings: [
      {
        key: "defaultRetentionKeepDaily",
        type: "number",
        label: "Default daily retention",
        description: "Number of daily backups to keep for auto-created backup jobs.",
        default: 7,
      },
      {
        key: "defaultRetentionKeepWeekly",
        type: "number",
        label: "Default weekly retention",
        default: 4,
      },
    ],
    slots: {
      "app.detail.tabs": {
        component: "data-table",
        props: {
          title: "Backups",
          dataSource: "/api/v1/organizations/{orgId}/backups",
        },
      },
      "settings.sections": {
        component: "form-section",
        props: {
          title: "Backup Targets",
          description: "Configure where backups are stored.",
          dataSource: "/api/v1/organizations/{orgId}/backups/targets",
        },
      },
      "app.detail.sidebar": {
        component: "status-badge",
        props: {
          label: "Backup",
          statusField: "lastBackupStatus",
        },
      },
    },
    nav: [
      {
        label: "Backups",
        icon: "database",
        path: "/backups",
        scope: "org",
      },
    ],
  },
};

export default manifest;
