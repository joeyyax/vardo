import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// GET /api/v1/mesh/config
// ---------------------------------------------------------------------------
// The route is reachable by any instance holding a mesh peer token, and is
// served on the public origin. It must never return a credential.

const PLACEHOLDER = {
  privateKey: "placeholder-github-private-key",
  clientSecret: "placeholder-github-client-secret",
  webhookSecret: "placeholder-github-webhook-secret",
  smtpPass: "placeholder-smtp-password",
  emailApiKey: "placeholder-email-api-key",
  accessKey: "placeholder-backup-access-key",
  secretKey: "placeholder-backup-secret-key",
  dnsApiToken: "placeholder-dns-api-token",
  zerosslEabKid: "placeholder-eab-kid",
  zerosslEabHmac: "placeholder-eab-hmac",
};

const {
  mockRequireMeshPeer,
  mockGetEmail,
  mockGetBackup,
  mockGetGitHub,
  mockGetFeatures,
  mockGetSsl,
} = vi.hoisted(() => ({
  mockRequireMeshPeer: vi.fn(),
  mockGetEmail: vi.fn(),
  mockGetBackup: vi.fn(),
  mockGetGitHub: vi.fn(),
  mockGetFeatures: vi.fn(),
  mockGetSsl: vi.fn(),
}));

vi.mock("@/lib/mesh/auth", () => ({
  requireMeshPeer: mockRequireMeshPeer,
}));

vi.mock("@/lib/system-settings", () => ({
  getEmailProviderConfig: mockGetEmail,
  getBackupStorageConfig: mockGetBackup,
  getGitHubAppConfig: mockGetGitHub,
  getFeatureFlagsConfig: mockGetFeatures,
  getSslConfig: mockGetSsl,
}));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import { GET } from "@/app/api/v1/mesh/config/route";

function makeRequest() {
  return new NextRequest("http://localhost/api/v1/mesh/config", {
    headers: { Authorization: "Bearer test-token" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMeshPeer.mockResolvedValue({ id: "peer-1", type: "dev" });
  mockGetEmail.mockResolvedValue({
    provider: "smtp",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUser: "mailer",
    smtpPass: PLACEHOLDER.smtpPass,
    apiKey: PLACEHOLDER.emailApiKey,
    fromEmail: "noreply@example.com",
    fromName: "Vardo",
  });
  mockGetBackup.mockResolvedValue({
    type: "s3",
    bucket: "vardo-backups",
    region: "us-east-1",
    endpoint: "https://s3.example.com",
    accessKey: PLACEHOLDER.accessKey,
    secretKey: PLACEHOLDER.secretKey,
  });
  mockGetGitHub.mockResolvedValue({
    appId: "12345",
    appSlug: "vardo-app",
    clientId: "Iv1.abc123",
    clientSecret: PLACEHOLDER.clientSecret,
    privateKey: PLACEHOLDER.privateKey,
    webhookSecret: PLACEHOLDER.webhookSecret,
  });
  mockGetFeatures.mockResolvedValue({ backups: true });
  mockGetSsl.mockResolvedValue({
    activeIssuers: ["le"],
    concurrentIssuers: 1,
    challengeType: "dns",
    dnsProvider: "cloudflare",
    dnsApiToken: PLACEHOLDER.dnsApiToken,
    zerosslEabKid: PLACEHOLDER.zerosslEabKid,
    zerosslEabHmac: PLACEHOLDER.zerosslEabHmac,
  });
});

describe("GET /api/v1/mesh/config", () => {
  it("returns no credential anywhere in the response body", async () => {
    const res = await GET(makeRequest());
    const raw = await res.text();

    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(PLACEHOLDER)) {
      expect(raw, `${name} leaked to mesh peers`).not.toContain(value);
    }
  });

  it("omits the credential keys from each section", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.github).not.toHaveProperty("privateKey");
    expect(body.github).not.toHaveProperty("clientSecret");
    expect(body.github).not.toHaveProperty("webhookSecret");
    expect(body.email).not.toHaveProperty("smtpPass");
    expect(body.email).not.toHaveProperty("apiKey");
    expect(body.backup).not.toHaveProperty("accessKey");
    expect(body.backup).not.toHaveProperty("secretKey");
    expect(body.ssl).not.toHaveProperty("dnsApiToken");
    expect(body.ssl).not.toHaveProperty("zerosslEabKid");
    expect(body.ssl).not.toHaveProperty("zerosslEabHmac");
  });

  it("still returns the non-secret config a joining instance needs", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.github).toEqual({
      appId: "12345",
      appSlug: "vardo-app",
      clientId: "Iv1.abc123",
    });
    expect(body.email.provider).toBe("smtp");
    expect(body.email.smtpHost).toBe("smtp.example.com");
    expect(body.backup.bucket).toBe("vardo-backups");
    expect(body.ssl.activeIssuers).toEqual(["le"]);
    expect(body.ssl.challengeType).toBe("dns");
    expect(body.features).toEqual({ backups: true });
  });

  it("names the sections whose credential the joining admin must supply", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.credentialsRequired).toEqual(
      expect.arrayContaining(["email", "backup", "github", "ssl"]),
    );
  });

  it("returns nulls when nothing is configured", async () => {
    mockGetEmail.mockResolvedValue(null);
    mockGetBackup.mockResolvedValue(null);
    mockGetGitHub.mockResolvedValue(null);
    mockGetFeatures.mockResolvedValue(null);
    mockGetSsl.mockResolvedValue({
      activeIssuers: ["le"],
      concurrentIssuers: 1,
      challengeType: "http",
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.email).toBeNull();
    expect(body.backup).toBeNull();
    expect(body.github).toBeNull();
    expect(body.credentialsRequired).toEqual([]);
  });

  it("returns 401 when the peer token is not valid", async () => {
    mockRequireMeshPeer.mockRejectedValue(new Error("Unauthorized"));

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
  });
});
