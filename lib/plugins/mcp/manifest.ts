import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "mcp-server",
  name: "MCP Server",
  description: "Model Context Protocol server for AI agent access. Exposes deploy, manage, and monitor tools via API tokens.",
  version: "1.0.0",
  builtIn: true,
  category: "integrations",
  icon: "https://cdn.simpleicons.org/anthropic",

  provides: ["mcp"],

  api: [
    { method: "POST", path: "/api/mcp", handler: "mcp-handler" },
    { method: "GET", path: "/api/mcp", handler: "mcp-sse-reject" },
    { method: "DELETE", path: "/api/mcp", handler: "mcp-session-noop" },
  ],

  ui: {
    settings: [
      {
        key: "enabled",
        type: "toggle",
        label: "Enable MCP endpoint",
        description: "Allow AI agents to manage apps via Model Context Protocol.",
        default: true,
      },
      {
        key: "allowedTools",
        type: "textarea",
        label: "Allowed tools",
        description: "Comma-separated list of tool names to expose. Leave empty for all tools.",
      },
    ],
    slots: {
      "admin.sections": {
        component: "form-section",
        props: {
          title: "AI Agent Access (MCP)",
          description: "Configure Model Context Protocol for Claude Code and other AI tools.",
        },
      },
      "settings.sections": {
        component: "form-section",
        props: {
          title: "API Tokens",
          description: "Create tokens for MCP and API access.",
          dataSource: "/api/v1/organizations/{orgId}/tokens",
        },
      },
    },
  },
};

export default manifest;
