import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseAcmeStore, readTar, selectCertificates, type AcmeCert } from "@/lib/ssl/cert-export";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";

let dir: string;
const pem: Record<string, { crt: string; key: string }> = {};

/** Self-signed cert with the given SANs, made at test time so no key sits in the repo. */
function make(name: string, san: string) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`), "-days", "30",
    "-subj", `/CN=${name}`, "-addext", `subjectAltName=${san}`,
  ], { stdio: "ignore" });
  pem[name] = { crt: readFileSync(join(dir, `${name}.crt`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8") };
}

const cert = (name: string, keyFrom = name): AcmeCert => ({ resolver: "le-dns", certificate: pem[name].crt, key: pem[keyFrom].key });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vardo-certs-"));
  make("pouch", "DNS:smtp.pouch.test,DNS:pouch.test");
  make("smtp", "DNS:smtp.pouch.test");
  make("wildcard", "DNS:*.pouch.test");
  make("other", "DNS:other.test");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const owned = new Set(["smtp.pouch.test", "pouch.test"]);

describe("selectCertificates", () => {
  it("exports a cert whose every name the app owns, under each name", () => {
    expect(selectCertificates([cert("pouch")], owned).map((c) => c.host)).toEqual(["pouch.test", "smtp.pouch.test"]);
  });

  it("refuses a cert that also names a host the app doesn't own", () => {
    expect(selectCertificates([cert("pouch")], new Set(["smtp.pouch.test"]))).toEqual([]);
  });

  it("never exports a wildcard, which would cover other apps' hosts", () => {
    expect(selectCertificates([cert("wildcard")], new Set(["*.pouch.test", ...owned]))).toEqual([]);
  });

  it("ignores certs for other hosts", () => {
    expect(selectCertificates([cert("other")], owned)).toEqual([]);
  });

  it("refuses a key that doesn't match its cert", () => {
    expect(selectCertificates([cert("smtp", "pouch")], owned)).toEqual([]);
  });

  it("skips an expired cert", () => {
    expect(selectCertificates([cert("smtp")], owned, new Date("2200-01-01"))).toEqual([]);
  });
});

describe("parseAcmeStore", () => {
  it("decodes every resolver's certificates", () => {
    const store = {
      "le-dns": {
        Account: {},
        Certificates: [{ domain: { main: "smtp.pouch.test" }, certificate: Buffer.from(pem.smtp.crt).toString("base64"), key: Buffer.from(pem.smtp.key).toString("base64") }],
      },
      le: { Certificates: null },
    };
    const certs = parseAcmeStore(JSON.stringify(store));
    expect(certs).toHaveLength(1);
    expect(certs[0].certificate).toBe(pem.smtp.crt);
  });

  it("returns nothing for a store it can't read", () => {
    expect(parseAcmeStore("{not json")).toEqual([]);
  });
});

describe("readTar", () => {
  it("reads the files docker cp archives", () => {
    const src = join(dir, "le");
    execFileSync("sh", ["-c", `mkdir -p "${src}" && printf '{"a":1}' > "${src}/acme-le.json" && COPYFILE_DISABLE=1 tar --format=ustar -cf "${dir}/le.tar" -C "${dir}" le`]);
    const entries = readTar(readFileSync(join(dir, "le.tar")));
    expect(entries.find((e) => e.name.endsWith("acme-le.json"))?.data.toString()).toBe('{"a":1}');
  });
});

describe("buildVardoOverlay certMount", () => {
  const fullCompose = { services: { "mail-smtp": { name: "mail-smtp", image: "x" }, web: { name: "web", image: "x" } } };

  it("mounts the cert volume read-only in the chosen services only", () => {
    const overlay = buildVardoOverlay({
      fullCompose, networkName: "vardo-network", hostCpus: 2,
      certMount: { services: ["mail-smtp"], volume: "mail-production_vardo-certs" },
    });
    expect(overlay.services["mail-smtp"].volumes).toEqual(["vardo-certs:/certs:ro"]);
    expect(overlay.services.web.volumes).toBeUndefined();
    expect(overlay.volumes?.["vardo-certs"]).toEqual({ external: true, name: "mail-production_vardo-certs" });
  });

  it("adds nothing without it", () => {
    const overlay = buildVardoOverlay({ fullCompose, networkName: "vardo-network", hostCpus: 2 });
    expect(overlay.volumes).toBeUndefined();
  });
});
