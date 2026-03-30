import { describe, it, expect } from "vitest";
import { detectContainerGpu, detectContainerPort, filterImageInheritedEnv, hasAtFileTraefikLabels } from "@/lib/docker/discover";

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

// ---------------------------------------------------------------------------
// detectContainerPort — port detection with fallback chain
// ---------------------------------------------------------------------------
// Priority: Traefik labels → ExposedPorts → PortBindings

describe("detectContainerPort", () => {
  it("returns the Traefik loadbalancer port when present", () => {
    const labels = {
      "traefik.http.services.myapp.loadbalancer.server.port": "8080",
    };
    expect(detectContainerPort(labels, [80, 443])).toBe(8080);
  });

  it("returns null when no labels, no exposed ports, no bound ports", () => {
    expect(detectContainerPort({}, [])).toBeNull();
  });

  it("returns the single exposed port when only one is declared", () => {
    expect(detectContainerPort({}, [80])).toBe(80);
  });

  it("returns the single exposed port regardless of value", () => {
    expect(detectContainerPort({}, [9000])).toBe(9000);
  });


  it("prefers 80 over other exposed ports", () => {
    expect(detectContainerPort({}, [3000, 80, 8080])).toBe(80);
  });

  it("prefers 8080 when 80 is not exposed", () => {
    expect(detectContainerPort({}, [3000, 8080])).toBe(8080);
  });

  it("prefers 3000 when 80 and 8080 are not exposed", () => {
    expect(detectContainerPort({}, [9000, 3000])).toBe(3000);
  });

  it("prefers 8000 when only 8000 and non-preferred ports are exposed", () => {
    expect(detectContainerPort({}, [9000, 8000])).toBe(8000);
  });

  it("falls back to the first exposed port when none are preferred", () => {
    expect(detectContainerPort({}, [9000, 9001])).toBe(9000);
  });

  it("falls back to the first bound port when no exposed ports exist", () => {
    expect(detectContainerPort({}, [], [4000, 5000])).toBe(4000);
  });

  it("returns null when bound ports list is empty and no exposed ports", () => {
    expect(detectContainerPort({}, [], [])).toBeNull();
  });

  it("Traefik label wins over exposed ports", () => {
    const labels = {
      "traefik.http.services.app.loadbalancer.server.port": "9999",
    };
    expect(detectContainerPort(labels, [80])).toBe(9999);
  });


  it("exposed ports win over bound ports", () => {
    expect(detectContainerPort({}, [8080], [3000])).toBe(8080);
  });
});

// ---------------------------------------------------------------------------
// hasAtFileTraefikLabels — @file provider reference detection
// ---------------------------------------------------------------------------

describe("hasAtFileTraefikLabels", () => {
  it("returns false when there are no labels", () => {
    expect(hasAtFileTraefikLabels({})).toBe(false);
  });

  it("returns false when there are no traefik labels", () => {
    expect(hasAtFileTraefikLabels({
      "com.docker.compose.project": "myapp",
      "com.docker.compose.service": "web",
    })).toBe(false);
  });

  it("returns false when a traefik label exists but has no @file value", () => {
    expect(hasAtFileTraefikLabels({
      "traefik.enable": "true",
      "traefik.http.routers.app.rule": "Host(`app.example.com`)",
    })).toBe(false);
  });

  it("returns false when a non-traefik label contains @file", () => {
    expect(hasAtFileTraefikLabels({
      "com.example.config": "something@file",
      "traefik.enable": "true",
    })).toBe(false);
  });

  it("returns true when a traefik label value contains @file", () => {
    expect(hasAtFileTraefikLabels({
      "traefik.http.services.app.loadbalancer.serversTransport": "app-insecure@file",
    })).toBe(true);
  });

  it("returns true when one of several traefik labels references @file", () => {
    expect(hasAtFileTraefikLabels({
      "traefik.enable": "true",
      "traefik.http.routers.app.rule": "Host(`app.example.com`)",
      "traefik.http.middlewares.my-mw.plugin": "something@file",
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
