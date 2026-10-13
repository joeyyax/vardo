import type { ProbeTemplate } from "./types";

export const actuator: ProbeTemplate = {
  id: "actuator",
  name: "Spring Boot Actuator",
  description: "For Spring Boot apps. The sensitive endpoints are already turned away; this adds the rest.",
  version: 1,
  detect: [{ path: "/actuator/health", body: /"status"\s*:\s*"(?:UP|DOWN)"/ }],
  turnAway: [
    { kind: "prefix", value: "/actuator/prometheus" },
    { kind: "prefix", value: "/actuator/metrics" },
    { kind: "prefix", value: "/actuator/loggers" },
    { kind: "prefix", value: "/actuator/caches" },
    { kind: "prefix", value: "/actuator/shutdown" },
  ],
};
