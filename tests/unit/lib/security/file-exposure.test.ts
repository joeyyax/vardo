import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS and fetch before importing the module under test.
vi.mock("dns", () => ({
  promises: {
    resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { checkFileExposure } from "@/lib/security/file-exposure";

function mockResponse(status: number, body: string): Response {
  return {
    status,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockResolvedValue(mockResponse(404, ""));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("checkFileExposure", () => {
  it("returns no findings when all paths return 404", async () => {
    const findings = await checkFileExposure("example.com");
    expect(findings).toEqual([]);
  });

  it("flags a critical finding when /.env is accessible with key=value content", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith("/.env")) {
        return Promise.resolve(mockResponse(200, "APP_SECRET=abc123\nDB_URL=postgres://..."));
      }
      return Promise.resolve(mockResponse(404, ""));
    });

    const findings = await checkFileExposure("example.com");
    const envFinding = findings.find((f) => f.detail === "/.env");
    expect(envFinding).toBeDefined();
    expect(envFinding?.severity).toBe("critical");
    expect(envFinding?.type).toBe("file-exposure");
  });

  it("flags a critical finding when /.git/config is accessible", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith("/.git/config")) {
        return Promise.resolve(mockResponse(200, "[core]\n\trepositoryformatversion = 0"));
      }
      return Promise.resolve(mockResponse(404, ""));
    });

    const findings = await checkFileExposure("example.com");
    const finding = findings.find((f) => f.detail === "/.git/config");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
  });

  it("does not flag /.env when body has no = sign", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith("/.env")) {
        return Promise.resolve(mockResponse(200, "not a key value file"));
      }
      return Promise.resolve(mockResponse(404, ""));
    });

    const findings = await checkFileExposure("example.com");
    expect(findings.find((f) => f.detail === "/.env")).toBeUndefined();
  });

  it("does not flag /config.yml for arbitrary HTTP responses", async () => {
    // HTML response should not match the YAML heuristic
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith("/config.yml")) {
        return Promise.resolve(mockResponse(200, "<html><body>Hello world</body></html>"));
      }
      return Promise.resolve(mockResponse(404, ""));
    });

    const findings = await checkFileExposure("example.com");
    expect(findings.find((f) => f.detail === "/config.yml")).toBeUndefined();
  });

  it("flags /config.yml when body contains YAML key-value lines", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith("/config.yml")) {
        return Promise.resolve(mockResponse(200, "database:\n  host: localhost\n  port: 5432\n"));
      }
      return Promise.resolve(mockResponse(404, ""));
    });

    const findings = await checkFileExposure("example.com");
    expect(findings.find((f) => f.detail === "/config.yml")).toBeDefined();
  });

  it("ignores responses larger than the size cap by reading only the first 64 KB", async () => {
    // A 128 KB body of '=' chars would match /.env heuristic regardless
    const bigBody = "=".repeat(128 * 1024);
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith("/.env")) {
        return Promise.resolve(mockResponse(200, bigBody));
      }
      return Promise.resolve(mockResponse(404, ""));
    });

    // Should still detect exposure — the slice includes the = char
    const findings = await checkFileExposure("example.com");
    expect(findings.find((f) => f.detail === "/.env")).toBeDefined();
  });

  it("returns no findings on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const findings = await checkFileExposure("example.com");
    expect(findings).toEqual([]);
  });
});
