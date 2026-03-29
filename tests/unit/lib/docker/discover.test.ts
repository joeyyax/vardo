import { describe, it, expect } from "vitest";
import { detectContainerGpu, filterImageInheritedEnv, parseTraefikPort, resolveContainerPort } from "@/lib/docker/discover";

// ---------------------------------------------------------------------------
// parseTraefikPort — extract container port from Traefik loadbalancer label
// ---------------------------------------------------------------------------
// Priority order for containerPort in getContainerDetail:
//   Traefik label → ExposedPorts[0] → null

describe("parseTraefikPort", () => {
  it("returns the port from a Traefik loadbalancer label", () => {
    expect(parseTraefikPort({
      "traefik.http.services.myapp.loadbalancer.server.port": "3000",
    })).toBe(3000);
  });

  it("works regardless of the service name in the label key", () => {
    expect(parseTraefikPort({
      "traefik.http.services.api-gateway.loadbalancer.server.port": "8080",
    })).toBe(8080);
  });

  it("returns null when no Traefik loadbalancer label is present", () => {
    expect(parseTraefikPort({})).toBeNull();
  });

  it("returns null for unrelated Traefik labels", () => {
    expect(parseTraefikPort({
      "traefik.enable": "true",
      "traefik.http.routers.myapp.rule": "Host(`app.example.com`)",
    })).toBeNull();
  });

  it("returns null when the port value is not a valid number", () => {
    expect(parseTraefikPort({
      "traefik.http.services.myapp.loadbalancer.server.port": "notaport",
    })).toBeNull();
  });

  it("returns null when the port value is empty", () => {
    expect(parseTraefikPort({
      "traefik.http.services.myapp.loadbalancer.server.port": "",
    })).toBeNull();
  });

  it("returns the port when the label is mixed with other labels", () => {
    expect(parseTraefikPort({
      "com.docker.compose.project": "myproject",
      "traefik.enable": "true",
      "traefik.http.routers.myapp.rule": "Host(`app.example.com`)",
      "traefik.http.services.myapp.loadbalancer.server.port": "4000",
    })).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// resolveContainerPort — full priority chain
// ---------------------------------------------------------------------------
// Priority order: Traefik label → ExposedPorts[0] → null

describe("resolveContainerPort", () => {
  it("returns the Traefik port when the label is present", () => {
    expect(resolveContainerPort(
      { "traefik.http.services.myapp.loadbalancer.server.port": "3000" },
      [8080],
    )).toBe(3000);
  });

  it("Traefik label takes priority over ExposedPorts", () => {
    expect(resolveContainerPort(
      { "traefik.http.services.myapp.loadbalancer.server.port": "3000" },
      [9000, 9001],
    )).toBe(3000);
  });

  it("falls back to ExposedPorts[0] when no Traefik label is present", () => {
    expect(resolveContainerPort({}, [8080, 9090])).toBe(8080);
  });

  it("returns null when there is no Traefik label and no ExposedPorts", () => {
    expect(resolveContainerPort({}, [])).toBeNull();
  });

  it("returns null when Traefik label is invalid and ExposedPorts is empty", () => {
    expect(resolveContainerPort(
      { "traefik.http.services.myapp.loadbalancer.server.port": "notaport" },
      [],
    )).toBeNull();
  });

  it("falls back to ExposedPorts[0] when Traefik label is invalid", () => {
    expect(resolveContainerPort(
      { "traefik.http.services.myapp.loadbalancer.server.port": "notaport" },
      [5000],
    )).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// detectContainerGpu — GPU heuristic for discovered containers
// ---------------------------------------------------------------------------
// Checks image name and Docker labels for NVIDIA indicators.
// The Docker list-containers API does not expose env vars or device mounts,
// so this is a best-effort check on what is available.

describe("detectContainerGpu", () => {
  // Image-name heuristics
  it("detects nvidia in the image name (case-insensitive)", () => {
    expect(detectContainerGpu("nvidia/cuda:12.0-base", {})).toBe(true);
    expect(detectContainerGpu("NVIDIA/cuda:12.0-base", {})).toBe(true);
  });

  it("detects cuda in the image name (case-insensitive)", () => {
    expect(detectContainerGpu("pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime", {})).toBe(true);
    expect(detectContainerGpu("my-CUDA-app:latest", {})).toBe(true);
  });

  it("detects images from nvcr.io", () => {
    expect(detectContainerGpu("nvcr.io/nvidia/pytorch:23.10-py3", {})).toBe(true);
  });

  it("returns false for unrelated images with no GPU labels", () => {
    expect(detectContainerGpu("nginx:latest", {})).toBe(false);
    expect(detectContainerGpu("postgres:17", {})).toBe(false);
    expect(detectContainerGpu("redis/redis-stack-server:7.4.0-v3", {})).toBe(false);
  });

  // Label heuristics
  it("detects com.nvidia.volumes.needed label", () => {
    expect(detectContainerGpu("myapp:latest", { "com.nvidia.volumes.needed": "nvidia_driver" })).toBe(true);
  });

  it("detects com.nvidia.cuda.version label", () => {
    expect(detectContainerGpu("myapp:latest", { "com.nvidia.cuda.version": "11.7" })).toBe(true);
  });

  it("returns false for non-NVIDIA labels", () => {
    expect(detectContainerGpu("myapp:latest", {
      "com.docker.compose.project": "myproject",
      "traefik.enable": "true",
    })).toBe(false);
  });

  // Image + label combinations
  it("returns true when image matches even if labels do not", () => {
    expect(detectContainerGpu("cuda-inference:v1", { "com.docker.compose.service": "inference" })).toBe(true);
  });

  it("returns true when label matches even if image does not", () => {
    expect(detectContainerGpu("myapp:latest", {
      "com.nvidia.cuda.version": "12.0",
      "com.docker.compose.service": "app",
    })).toBe(true);
  });
});

describe("filterImageInheritedEnv", () => {
  it("removes vars that are identical in the image", () => {
    const imageEnv = [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LANG=C.UTF-8",
    ];
    const containerEnv = [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LANG=C.UTF-8",
      "MY_SECRET=hunter2",
    ];
    expect(filterImageInheritedEnv(containerEnv, imageEnv)).toEqual([
      "MY_SECRET=hunter2",
    ]);
  });

  it("keeps vars with the same key but a different value (explicit override)", () => {
    const imageEnv = ["PATH=/usr/bin:/bin"];
    const containerEnv = ["PATH=/usr/local/bin:/usr/bin:/bin", "APP_ENV=production"];
    expect(filterImageInheritedEnv(containerEnv, imageEnv)).toEqual([
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "APP_ENV=production",
    ]);
  });

  it("returns all vars when imageEnv is empty (fallback path)", () => {
    const containerEnv = ["PATH=/usr/bin", "SECRET=abc"];
    expect(filterImageInheritedEnv(containerEnv, [])).toEqual(containerEnv);
  });

  it("returns empty array when both lists are empty", () => {
    expect(filterImageInheritedEnv([], [])).toEqual([]);
  });

  it("returns empty array when all container vars are inherited", () => {
    const env = ["PATH=/usr/bin", "LANG=C"];
    expect(filterImageInheritedEnv(env, env)).toEqual([]);
  });

  it("handles vars without an equals sign gracefully", () => {
    const imageEnv = ["PATH=/usr/bin"];
    const containerEnv = ["PATH=/usr/bin", "NOVALUE", "KEY=val"];
    // "NOVALUE" is not in imageEnv set → kept
    expect(filterImageInheritedEnv(containerEnv, imageEnv)).toEqual([
      "NOVALUE",
      "KEY=val",
    ]);
  });
});
