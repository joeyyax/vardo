import type { PluginManifest } from "../manifest";

const manifest: PluginManifest = {
  id: "container-import",
  name: "Container Import",
  description:
    "Discover and import running Docker containers into Vardo. Scans for unmanaged containers and compose projects.",
  version: "1.0.0",
  builtIn: true,
  category: "management",
  icon: "https://cdn.simpleicons.org/docker",
  provides: ["container-import"],
};

export default manifest;
