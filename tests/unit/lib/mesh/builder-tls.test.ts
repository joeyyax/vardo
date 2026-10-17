// The builder's TLS files: written into its container from this instance's CA, and a replaced set restarts it.

import { describe, it, expect, vi } from "vitest";
import { createCertAuthority, generateEd25519, issueCertificate, issuedBy } from "@/lib/mesh/x509";

const HOUR = 3600_000;
const ca = createCertAuthority("vardo-mesh-builder CA", 24 * 365 * HOUR);

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: async () => JSON.stringify(ca), invalidateSettingsCache: () => {} }));

const { syncBuilderTls } = await import("@/lib/mesh/builder-tls");

/** A fake builder container holding TLS files. */
function container(files: Record<string, string> = {}, missing = false) {
  const calls: string[][] = [];
  const exec = async (args: string[], input?: string) => {
    calls.push(args);
    if (missing) throw new Error("Error response from daemon: No such container: vardo-mesh-builder");
    if (args[0] === "restart") return "";
    const script = args[args.length - 1];
    if (input !== undefined) {
      files[script.match(/vardo-tls\/(\w+\.pem)\.tmp/)![1]] = input;
      return "";
    }
    return `${files["ca.pem"] ?? ""}#\n${files["cert.pem"] ?? ""}`;
  };
  return { calls, exec, files };
}

describe("syncBuilderTls", () => {
  it("writes the key, server certificate and CA, with the CA last, into a waiting builder", async () => {
    const c = container();
    expect(await syncBuilderTls({ exec: c.exec })).toBe("written");
    const writes = c.calls.filter((a) => a.includes("-i")).map((a) => a[a.length - 1].match(/(\w+\.pem)\.tmp/)![1]);
    expect(writes).toEqual(["key.pem", "cert.pem", "ca.pem"]);
    expect(c.files["ca.pem"]).toBe(ca.cert);
    expect(issuedBy(c.files["cert.pem"], ca.cert)).toBe(true);
    expect(c.calls.some((a) => a[0] === "restart")).toBe(false);
  });

  it("leaves a current set alone", async () => {
    const server = generateEd25519();
    const cert = issueCertificate(ca, { publicKey: server.publicKey, commonName: "vardo-mesh-builder", usage: "server", validMs: 365 * 24 * HOUR, dnsNames: ["vardo-mesh-builder"] });
    const c = container({ "ca.pem": ca.cert, "cert.pem": cert, "key.pem": server.privateKey });
    expect(await syncBuilderTls({ exec: c.exec })).toBe("unchanged");
    expect(c.calls).toHaveLength(1);
  });

  it("replaces a set from another CA and restarts the builder to load it", async () => {
    const other = createCertAuthority("old", HOUR);
    const c = container({ "ca.pem": other.cert, "cert.pem": "x" });
    expect(await syncBuilderTls({ exec: c.exec })).toBe("written");
    expect(c.calls.at(-1)).toEqual(["restart", "vardo-mesh-builder"]);
  });

  it("does nothing when the builder isn't running here", async () => {
    expect(await syncBuilderTls({ exec: container({}, true).exec })).toBe("absent");
  });
});
