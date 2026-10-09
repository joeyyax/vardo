import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { composeEnvFile } from "@/lib/env/compose-env-file";
import { formatEnvVar } from "@/lib/env/dotenv";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { dockerEnv } from "@/lib/docker/docker-env";

describe("composeEnvFile", () => {
  it("writes today's shapes byte for byte", () => {
    const out = composeEnvFile({
      PLAIN: "abc",
      EMPTY: "",
      EQ: "a=b=c",
      SPACE: "a b",
      HASH: "x#y",
      DOLLAR: "pa$word",
      DQUOTE: 'say "hi"',
      SQUOTE: "it's",
      BACKSLASH: "C:\\dir",
      NEWLINE: "a\nb",
      CR: "a\r\nb",
    });
    expect(out).toBe(
      [
        "PLAIN=abc",
        "EMPTY=",
        "EQ=a=b=c",
        'SPACE="a b"',
        'HASH="x#y"',
        'DOLLAR="pa$$word"',
        'DQUOTE="say \\"hi\\""',
        "SQUOTE=\"it's\"",
        'BACKSLASH="C:\\\\dir"',
        'NEWLINE="a\\nb"',
        'CR="a\\r\\nb"',
      ].join("\n"),
    );
  });
});

const hasCompose = spawnSync("docker", ["compose", "version"], { env: dockerEnv() }).status === 0;

// Real `docker compose config`, as the deploy path invokes it. Compose prints `$` as `$$` in config output.
describe.skipIf(!hasCompose)("slot .env through docker compose", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nAQAB==\n+/abc\n-----END PRIVATE KEY-----\n";
  const JSON_CRED = '{\n  "type": "service_account",\n  "private_key": "-----BEGIN-----\\nabc\\n-----END-----\\n",\n  "path": "C:\\\\dir"\n}';
  const values: Record<string, string> = {
    PEM,
    JSON_CRED,
    CRLF: "a\r\nb\r\n",
    QUOTES: `he said "hi" and 'bye'`,
    BACKSLASHES: "C:\\new\\table \\\\ \\n",
    HASH_EQ: "a=b # c",
    TRAILING_NL: "x\n\n",
    PLAIN: "abc",
  };

  function composeEnv(envText: string): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), "vardo-env-"));
    try {
      writeFileSync(join(dir, "docker-compose.yml"), "services:\n  a:\n    image: alpine\n    env_file: [.env]\n");
      writeFileSync(join(dir, ".env"), envText);
      const res = spawnSync("docker", ["compose", "config", "--format", "json"], {
        cwd: dir,
        env: dockerEnv(),
        encoding: "utf-8",
      });
      if (res.status !== 0) throw new Error(`compose config failed: ${res.stderr}`);
      return JSON.parse(res.stdout).services.a.environment;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("delivers values byte-identical", () => {
    expect(composeEnv(composeEnvFile(values))).toEqual(values);
  });

  it("delivers a value saved in the editor format", () => {
    const stored = Object.entries(values).map(([k, v]) => formatEnvVar(k, v)).join("\n");
    expect(composeEnv(composeEnvFile(parseEnvToMap(stored)))).toEqual(values);
  });

  it("delivers `$` literally instead of interpolating it", () => {
    const dollars = { A: "pa$word", B: "${NOT_A_VAR}", C: "$$already", D: "cost $5 and trailing $" };
    const env = composeEnv(composeEnvFile(dollars));
    // config prints a literal `$` as `$$`.
    expect(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\$\$/g, "$")]))).toEqual(dollars);
  });

  it("fails when a newline is written raw", () => {
    const broken = Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n");
    let got: Record<string, string> | null = null;
    try { got = composeEnv(broken); } catch { /* compose rejects it */ }
    expect(got).not.toEqual(values);
  });
});
