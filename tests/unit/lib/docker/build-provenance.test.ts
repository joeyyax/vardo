// Provenance on images built on a target: requesting instance, app and commit, as labels and annotations.

import { describe, it, expect } from "vitest";
import { bakeLabelArgs, provenanceLabels } from "@/lib/docker/build-provenance";
import { registryOutput } from "@/lib/docker/direct-export";
import { serviceBakeArgs } from "@/lib/docker/compose-build";
import { dockerfileBuildArgs } from "@/lib/docker/buildpack-args";

const labels = provenanceLabels({ requester: "jy0", requesterId: "8c1f-uuid", app: "shop", gitSha: "abc1234def" });

describe("provenance", () => {
  it("names the requesting instance, the app and the commit", () => {
    expect(labels).toEqual({
      "dev.vardo.build.requester": "jy0",
      "dev.vardo.build.requester-id": "8c1f-uuid",
      "dev.vardo.build.app": "shop",
      "org.opencontainers.image.revision": "abc1234def",
    });
  });

  it("leaves out what it doesn't know and keeps values that can't break an output", () => {
    expect(provenanceLabels({ requester: "Long House, Inc=1", gitSha: null })).toEqual({ "dev.vardo.build.requester": "Long-House--Inc-1" });
  });

  it("labels a Dockerfile build and each baked service", () => {
    expect(dockerfileBuildArgs({ imageName: "i", dockerfile: "D", context: ".", loadArgs: [], envVars: {}, labels: { a: "1" } })).toContain("a=1");
    expect(bakeLabelArgs(["web"], { a: "1" })).toEqual(["--set", "web.labels.a=1"]);
    expect(serviceBakeArgs("/b.json", { web: "type=docker,dest=/t.tar" }, ["web"], { a: "1" })).toEqual(expect.arrayContaining(["--set", "web.labels.a=1"]));
  });

  it("annotates a pushed image's manifest", () => {
    expect(registryOutput("reg/shop:k", "gzip", { "org.opencontainers.image.revision": "abc" })).toBe(
      "type=image,name=reg/shop:k,push=true,compression=gzip,annotation.org.opencontainers.image.revision=abc",
    );
  });
});
