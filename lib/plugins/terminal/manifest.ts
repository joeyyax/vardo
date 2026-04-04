import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "terminal",
  name: "Web Terminal",
  description: "Browser-based terminal access to running containers via WebSocket.",
  version: "1.0.0",
  category: "tools",

  provides: ["terminal"],

  ui: {
    settings: [
      {
        key: "enabled",
        type: "toggle",
        label: "Enable web terminal",
        description: "Allow browser-based shell access to running containers.",
        default: false,
      },
      {
        key: "defaultShell",
        type: "select",
        label: "Default shell",
        default: "/bin/sh",
        options: [
          { label: "/bin/sh", value: "/bin/sh" },
          { label: "/bin/bash", value: "/bin/bash" },
          { label: "/bin/zsh", value: "/bin/zsh" },
        ],
      },
      {
        key: "idleTimeoutMs",
        type: "number",
        label: "Idle timeout (ms)",
        description: "Disconnect terminal after this much idle time.",
        default: 600000,
      },
    ],
    slots: {
      "app.detail.actions": {
        component: "action-button",
        props: {
          label: "Terminal",
          icon: "terminal",
          action: "/api/v1/organizations/{orgId}/apps/{appId}/terminal",
        },
      },
    },
  },
};

export default manifest;
