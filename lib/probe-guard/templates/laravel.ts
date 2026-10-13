import type { ProbeTemplate } from "./types";

export const laravel: ProbeTemplate = {
  id: "laravel",
  name: "Laravel",
  description: "For Laravel apps. Turns away log files and debug tools.",
  version: 1,
  detect: [{ cookie: "laravel_session" }],
  turnAway: [
    { kind: "prefix", value: "/storage/logs" },
    { kind: "prefix", value: "/telescope" },
    { kind: "prefix", value: "/horizon" },
  ],
};
