import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "git-integration",
  name: "Git Integration",
  description: "GitHub OAuth, deploy keys, webhook auto-deploy, and PR preview environments.",
  version: "1.0.0",
  category: "git",
  icon: "https://cdn.simpleicons.org/github",

  provides: ["git-integration"],

  ui: {
    settings: [
      {
        key: "githubClientId",
        type: "text",
        label: "GitHub OAuth Client ID",
        description: "From your GitHub OAuth App settings.",
      },
      {
        key: "githubClientSecret",
        type: "password",
        label: "GitHub OAuth Client Secret",
      },
      {
        key: "githubAppId",
        type: "text",
        label: "GitHub App ID",
        description: "Optional. Enables repository access without personal tokens.",
      },
      {
        key: "autoDeployOnPush",
        type: "toggle",
        label: "Auto-deploy on push",
        description: "Automatically deploy when commits are pushed to the tracked branch.",
        default: true,
      },
      {
        key: "previewEnvironments",
        type: "toggle",
        label: "PR preview environments",
        description: "Create temporary environments for pull requests.",
        default: false,
      },
    ],
    slots: {
      "app.detail.info": {
        component: "key-value-row",
        props: {
          label: "Repository",
          valueSource: "/api/v1/plugins/git-integration/repo-info",
        },
      },
      "settings.sections": {
        component: "form-section",
        props: {
          title: "GitHub Integration",
          description: "Connect GitHub for auto-deploy and PR previews.",
        },
      },
    },
  },
};

export default manifest;
