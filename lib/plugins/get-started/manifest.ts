import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "get-started",
  name: "Get Started Guide",
  description:
    "Interactive setup checklist for new instances. Disable when you're done.",
  version: "1.0.0",
  category: "core",
  provides: ["onboarding"],
};

export default manifest;
