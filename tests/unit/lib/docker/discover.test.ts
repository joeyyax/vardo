import { describe, it, expect } from "vitest";
import { detectContainerGpu } from "@/lib/docker/discover";

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
