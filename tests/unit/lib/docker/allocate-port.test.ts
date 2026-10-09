import { describe, it, expect } from "vitest";
import { parseHostPorts } from "@/lib/docker/ports";

describe("parseHostPorts", () => {
  it("reads host ports bound on 0.0.0.0", () => {
    const out = "0.0.0.0:32800->80/tcp, :::32800->80/tcp\n127.0.0.1:7100->5432/tcp\n\n0.0.0.0:40001->3000/tcp, 0.0.0.0:40002->3001/tcp\n";
    expect([...parseHostPorts(out)].sort()).toEqual([32800, 40001, 40002]);
  });

  it("is empty for no output", () => {
    expect(parseHostPorts("").size).toBe(0);
  });
});
