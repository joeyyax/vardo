import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "error-tracking",
  name: "Error Tracking",
  description:
    "Capture and aggregate application errors via GlitchTip or Sentry.",
  version: "1.0.0",
  category: "monitoring",
  icon: "https://cdn.simpleicons.org/sentry",

  provides: ["error-tracking"],

  requires: {
    services: [
      {
        name: "glitchtip",
        check: "http",
        default: "http://glitchtip:8000",
        setting: "glitchtipUrl",
        provisionable: true,
        templateName: "glitchtip",
      },
    ],
  },

  ui: {
    settings: [
      {
        key: "glitchtipUrl",
        type: "text",
        label: "GlitchTip URL",
        description: "URL of your GlitchTip or Sentry-compatible instance.",
        default: "http://glitchtip:8000",
      },
      {
        key: "dsn",
        type: "password",
        label: "DSN",
        description: "Data Source Name for error reporting.",
      },
    ],
  },
};

export default manifest;
