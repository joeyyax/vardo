import { describe, it, expect } from "vitest";
import { parseNetworking } from "@/lib/config/parse-networking";

describe("parseNetworking", () => {
  it("creates a primary domain from the networking block", () => {
    const result = parseNetworking({ domain: "app.example.com", ssl: true });
    expect(result).toEqual([
      {
        domain: "app.example.com",
        port: 3000,
        ssl: true,
        isPrimary: true,
      },
    ]);
  });

  it("creates redirect domains pointing to the primary", () => {
    const result = parseNetworking({
      domain: "app.example.com",
      ssl: true,
      redirects: ["www.example.com"],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      domain: "app.example.com",
      port: 3000,
      ssl: true,
      isPrimary: true,
    });
    expect(result[1]).toEqual({
      domain: "www.example.com",
      port: 3000,
      ssl: true,
      isPrimary: false,
      redirectTo: "https://app.example.com",
      redirectCode: 301,
    });
  });

  it("handles multiple redirects", () => {
    const result = parseNetworking({
      domain: "app.example.com",
      ssl: true,
      redirects: ["www.example.com", "old.example.com"],
    });
    expect(result).toHaveLength(3);
    expect(result[1].domain).toBe("www.example.com");
    expect(result[2].domain).toBe("old.example.com");
  });

  it("uses custom container port", () => {
    const result = parseNetworking({ domain: "app.example.com" }, 8080);
    expect(result[0].port).toBe(8080);
  });

  it("defaults ssl to false for localhost domains", () => {
    const result = parseNetworking({ domain: "myapp.localhost" });
    expect(result[0].ssl).toBe(false);
  });

  it("defaults ssl to true for non-localhost domains", () => {
    const result = parseNetworking({ domain: "app.example.com" });
    expect(result[0].ssl).toBe(true);
  });

  it("respects explicit ssl: false", () => {
    const result = parseNetworking({
      domain: "app.example.com",
      ssl: false,
    });
    expect(result[0].ssl).toBe(false);
  });

  it("returns empty array when no domain is set", () => {
    const result = parseNetworking({ ssl: true });
    expect(result).toEqual([]);
  });
});
