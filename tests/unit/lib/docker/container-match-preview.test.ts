import { describe, it, expect } from "vitest";
import { matchContainers } from "@/lib/docker/container-match";
import type { ContainerInfo } from "@/lib/docker/client";

// notes-api's exit reason once named `notes-api-pr-25-...`: the
// preview's containers carry the app's id label and were matched as its own.

function container(name: string, env: string, state = "running"): ContainerInfo {
  return {
    id: name,
    name,
    state,
    labels: {
      "vardo.project": "notes-api",
      "vardo.project.id": "app-1",
      "vardo.environment": env,
      "com.docker.compose.project": name.replace(/-web-1$/, ""),
      "com.docker.compose.service": "web",
    },
  } as unknown as ContainerInfo;
}

const APP = {
  id: "app-1",
  name: "notes-api",
  status: "active",
  parentAppId: null,
  composeService: null,
  containerName: null,
  importedContainerId: null,
};

describe("matchContainers", () => {
  it("leaves out a preview's containers", () => {
    const prod = container("notes-api-production-blue-web-1", "production", "exited");
    const preview = container("notes-api-pr-25-blue-web-1", "pr-25");

    expect(matchContainers(APP, [prod, preview])).toEqual([prod]);
  });

  it("keeps the production containers", () => {
    const prod = container("notes-api-production-blue-web-1", "production");

    expect(matchContainers(APP, [prod])).toEqual([prod]);
  });
});
