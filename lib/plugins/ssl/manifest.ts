import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "ssl",
  name: "SSL / TLS",
  description: "Automatic TLS certificates via Let's Encrypt with DNS-01 or HTTP-01 challenge.",
  version: "1.0.0",
  builtIn: true,
  category: "ssl",
  icon: "https://cdn.simpleicons.org/letsencrypt",

  provides: ["ssl"],

  requires: {
    services: [
      {
        name: "traefik",
        check: "http",
        default: "http://traefik:8080/api/overview",
        setting: "traefikApiUrl",
        provisionable: false, // Part of core compose stack
      },
    ],
  },

  hooks: [
    {
      event: "before.cert.issue",
      handler: "validate-domain",
      priority: 50,
      failMode: "fail",
    },
  ],

  ui: {
    settings: [
      {
        key: "certResolver",
        type: "select",
        label: "Certificate resolver",
        description: "How to obtain TLS certificates.",
        default: "letsencrypt-dns",
        options: [
          { label: "Let's Encrypt (DNS-01)", value: "letsencrypt-dns" },
          { label: "Let's Encrypt (HTTP-01)", value: "letsencrypt-http" },
          { label: "Custom / Manual", value: "custom" },
        ],
      },
      {
        key: "acmeEmail",
        type: "text",
        label: "ACME email",
        description: "Email for Let's Encrypt notifications.",
        required: true,
      },
    ],
    slots: {
      "settings.sections": {
        component: "form-section",
        props: {
          title: "SSL / TLS",
          description: "Configure automatic certificate management.",
        },
      },
    },
  },
};

export default manifest;
