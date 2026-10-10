import { describe, it, expect } from "vitest";
import { describeTunnelError, recordTunnelFailure, recordTunnelOk, tunnelFailure } from "@/lib/mesh/tunnel-status";

describe("tunnel status", () => {
  it("names the socket error fetch hides in its cause", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" }) });
    expect(describeTunnelError(err)).toBe("EHOSTUNREACH");
  });

  it("keeps a failure until the tunnel answers again", () => {
    const err = new TypeError("fetch failed", { cause: { code: "EHOSTUNREACH" } });
    recordTunnelFailure("p1", "peer", "http://10.99.0.2:3000", err);
    expect(tunnelFailure("p1")?.error).toBe("http://10.99.0.2:3000 unreachable over the tunnel (EHOSTUNREACH)");

    recordTunnelOk("p1", "peer");
    expect(tunnelFailure("p1")).toBeNull();
  });
});
