import { describe, expect, it } from "vitest";
import { parsePortString } from "@/lib/docker/compose-inject";

describe("parsePortString", () => {
  it("reads the plain forms", () => {
    expect(parsePortString("3000")).toEqual({ internal: 3000 });
    expect(parsePortString("8080:3000")).toEqual({ internal: 3000, external: 8080 });
    expect(parsePortString("0.0.0.0:8080:3000")).toEqual({ internal: 3000, external: 8080 });
    expect(parsePortString("8080:3000/tcp")).toEqual({ internal: 3000, external: 8080 });
  });

  it("does not split inside a ${VAR:-default}, which read as a negative host port", () => {
    expect(parsePortString("${WIREGUARD_PORT:-51820}:51820/udp")).toEqual({
      internal: 51820,
      external: undefined,
    });
    expect(parsePortString("${POSTGRES_PORT:-7100}:5432")).toEqual({
      internal: 5432,
      external: undefined,
    });
  });

  it("still reads a plain interpolation with no default", () => {
    expect(parsePortString("${PORT}:3000")).toEqual({ internal: 3000, external: undefined });
  });

  it("gives up when the container port itself is interpolated, rather than guessing", () => {
    expect(parsePortString("8080:${APP_PORT:-3000}")).toBeNull();
  });
});
