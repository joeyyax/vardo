import { describe, expect, it } from "vitest";
import { stackServices, type StackContainer } from "@/lib/docker/stack-services";

const row = (name: string, project: string, state = "running"): StackContainer => ({
  name,
  containerId: name,
  status: state === "running" ? "Up 3 minutes" : "Exited (0) 2 minutes ago",
  state,
  image: "example",
  project,
});

const rows = [
  row("vardo-production-blue-frontend-1", "vardo-production-blue"),
  row("vardo-production-blue-worker-1", "vardo-production-blue"),
  row("vardo-production-green-frontend-1", "vardo-production-green", "exited"),
  row("vardo-production-green-worker-1", "vardo-production-green", "exited"),
  row("vardo-redis", "vardo"),
  row("vardo-postgres", "vardo"),
  row("vardo-www-production-green-vardo-www-1", "vardo-www-production-green"),
  row("vardo-www-production-blue-vardo-www-1", "vardo-www-production-blue", "exited"),
];

describe("stackServices", () => {
  it("leaves out apps whose names start with vardo-", () => {
    const names = stackServices(rows, "vardo-production-blue").map((s) => s.name);
    expect(names.some((n) => n.startsWith("vardo-www"))).toBe(false);
    expect(names).toContain("vardo-redis");
  });

  it("marks the idle slot as standby and lists it last", () => {
    const services = stackServices(rows, "vardo-production-blue");
    expect(services.filter((s) => s.role === "standby").map((s) => s.name)).toEqual([
      "vardo-production-green-frontend-1",
      "vardo-production-green-worker-1",
    ]);
    expect(services.at(-1)?.role).toBe("standby");
  });

  it("keeps an exited container in the active slot as a service", () => {
    const services = stackServices(
      [row("vardo-production-blue-worker-1", "vardo-production-blue", "exited"), ...rows.slice(2)],
      "vardo-production-blue",
    );
    expect(services.find((s) => s.name === "vardo-production-blue-worker-1")?.role).toBe("service");
  });

  it("finds the active slot from running containers without its own project", () => {
    const services = stackServices(rows, null);
    expect(services.find((s) => s.name === "vardo-production-green-frontend-1")?.role).toBe("standby");
    expect(services.some((s) => s.name.startsWith("vardo-www"))).toBe(false);
  });
});
