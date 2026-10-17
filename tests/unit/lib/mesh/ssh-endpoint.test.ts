// Mesh SSH endpoint: which key lines reach authorized_keys, and how they're written into the container.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec, written } = vi.hoisted(() => ({ mockExec: vi.fn(), written: [] as string[] }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: mockExec }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: async () => null, invalidateSettingsCache: () => {}, setSystemSetting: async () => {} }));
vi.mock("node:child_process", () => ({
  execFile: (_file: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    let data = "";
    queueMicrotask(() => cb(null));
    return { stdin: { end: (s: string) => void written.push(`${args.join(" ")}\n${(data += s)}`) } };
  },
}));

const { DIAL_STDIO, normalizeEd25519, renderAuthorizedKeys, syncAuthorizedKeys, meshSshHostKey, resetHostKeyCache } = await import(
  "@/lib/mesh/ssh-endpoint"
);

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGI6/QR1fwt33EFMygRHuBK82QAh42lFkI8Qzdfxv3Ts";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK90j9wHyHnIT5iWOwJyQR0rHdrJmQ04c5uM5t7f56qU";

beforeEach(() => {
  mockExec.mockReset();
  written.length = 0;
  resetHostKeyCache();
});

describe("normalizeEd25519", () => {
  it("keeps type and key and drops the comment", () => {
    expect(normalizeEd25519(`${KEY_A} root@lh\n`)).toBe(KEY_A);
  });

  it("refuses anything that could add options or lines to authorized_keys", () => {
    expect(normalizeEd25519(`command="sh" ${KEY_A}`)).toBeNull();
    expect(normalizeEd25519(`${KEY_A}\nssh-ed25519 AAAA`)).toBe(KEY_A);
    expect(normalizeEd25519("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ")).toBeNull();
    expect(normalizeEd25519(`${KEY_A}x`)).toBeNull();
    expect(normalizeEd25519(42)).toBeNull();
  });
});

describe("renderAuthorizedKeys", () => {
  it("pins each key to its peer's tunnel address and to dial-stdio, with nothing else allowed", () => {
    const out = renderAuthorizedKeys([
      { id: "peer-b", internalIp: "10.99.0.3", peerSshKey: KEY_B },
      { id: "peer-a", internalIp: "10.99.0.1", peerSshKey: `${KEY_A} jy0` },
    ]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(/^# /);
    expect(lines.slice(1)).toEqual([
      `from="10.99.0.1",restrict,command="${DIAL_STDIO}" ${KEY_A} vardo-peer-peer-a`,
      `from="10.99.0.3",restrict,command="${DIAL_STDIO}" ${KEY_B} vardo-peer-peer-b`,
    ]);
  });

  it("leaves out a peer with no key, a bad key or an address outside the mesh", () => {
    const out = renderAuthorizedKeys([
      { id: "none", internalIp: "10.99.0.4", peerSshKey: null },
      { id: "bad", internalIp: "10.99.0.5", peerSshKey: `restrict ${KEY_A}` },
      { id: "far", internalIp: "192.168.1.5", peerSshKey: KEY_A },
      { id: "wide", internalIp: "10.99.0.0/24", peerSshKey: KEY_A },
      { id: "x\ny", internalIp: "10.99.0.6", peerSshKey: KEY_A },
    ]);
    expect(out.trim().split("\n")).toHaveLength(1);
  });
});

describe("syncAuthorizedKeys", () => {
  const peers = [{ id: "peer-a", internalIp: "10.99.0.1", peerSshKey: KEY_A }];

  it("does nothing when the endpoint isn't running here", async () => {
    mockExec.mockRejectedValue(Object.assign(new Error("exit 1"), { stderr: "Error response from daemon: No such container: vardo-mesh-ssh" }));
    expect(await syncAuthorizedKeys(peers)).toBe("absent");
    expect(written).toEqual([]);
  });

  it("leaves a matching file alone", async () => {
    mockExec.mockResolvedValue({ stdout: renderAuthorizedKeys(peers), stderr: "" });
    expect(await syncAuthorizedKeys(peers)).toBe("unchanged");
    expect(written).toEqual([]);
  });

  it("replaces a stale file in one move, which drops an unlinked peer's key", async () => {
    mockExec.mockResolvedValue({ stdout: renderAuthorizedKeys([...peers, { id: "gone", internalIp: "10.99.0.9", peerSshKey: KEY_B }]), stderr: "" });
    expect(await syncAuthorizedKeys(peers)).toBe("written");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("exec -i vardo-mesh-ssh sh -c umask 022 && cat > /etc/ssh/vardo/authorized_keys.tmp && mv -f");
    expect(written[0]).toContain(KEY_A);
    expect(written[0]).not.toContain(KEY_B);
  });
});

describe("meshSshHostKey", () => {
  it("reads the endpoint's host key from its container", async () => {
    mockExec.mockResolvedValue({ stdout: `${KEY_B} vardo-mesh\n`, stderr: "" });
    expect(await meshSshHostKey()).toBe(KEY_B);
    expect(mockExec.mock.calls[0][1]).toEqual(["exec", "vardo-mesh-ssh", "cat", "/etc/ssh/vardo/ssh_host_ed25519_key.pub"]);
  });

  it("is null when the container isn't there", async () => {
    mockExec.mockRejectedValue(new Error("No such container"));
    expect(await meshSshHostKey()).toBeNull();
  });
});
