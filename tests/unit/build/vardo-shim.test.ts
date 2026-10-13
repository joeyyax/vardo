import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// /usr/local/bin/vardo is a stable shim; the CLI lives in the serving slot and follows deploys.

const ROOT = join(__dirname, "../../..");
let dir: string;
let lib: string;

function run(vardo: string, bin: string, args: string[] = []) {
  const r = spawnSync("bash", [bin, ...args], { encoding: "utf8", env: { ...process.env, VARDO_DIR: "/wrong" } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Writes the shim for `vardo` through install_shortcut. */
function install(vardo: string): string {
  const bin = join(vardo, "bin-vardo");
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\nDRY_RUN=false\ninstall_shortcut`], {
    encoding: "utf8",
    env: { ...process.env, VARDO_DIR: vardo, VARDO_BIN: bin },
  });
  expect(r.status, r.stderr).toBe(0);
  return bin;
}

/** A fake CLI that reports where it ran from and the VARDO_DIR it received. */
function fakeCli(path: string, tag: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `echo "${tag} dir=$VARDO_DIR args=$*"\n`);
}

function vardoDir(): string {
  return mkdtempSync(join(dir, "vardo-"));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vardo-shim-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(ROOT, "install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the vardo shim", { timeout: 30_000 }, () => {
  it("runs the serving slot's CLI with VARDO_DIR set", () => {
    const vardo = vardoDir();
    fakeCli(join(vardo, "apps/vardo/production/green/scripts/vardo-cli.sh"), "SLOT");
    symlinkSync("green", join(vardo, "apps/vardo/production/current"));
    fakeCli(join(vardo, "apps/vardo/env/blue/scripts/vardo-cli.sh"), "LEGACY");
    symlinkSync("blue", join(vardo, "apps/vardo/env/current"));
    fakeCli(join(vardo, "scripts/vardo-cli.sh"), "FLAT");
    const r = run(vardo, install(vardo), ["status", "--x"]);
    expect(r.out.trim()).toBe(`SLOT dir=${vardo} args=status --x`);
  });

  it("follows the current symlink after a deploy flips it", () => {
    const vardo = vardoDir();
    fakeCli(join(vardo, "apps/vardo/production/blue/scripts/vardo-cli.sh"), "BLUE");
    fakeCli(join(vardo, "apps/vardo/production/green/scripts/vardo-cli.sh"), "GREEN");
    symlinkSync("blue", join(vardo, "apps/vardo/production/current"));
    const bin = install(vardo);
    expect(run(vardo, bin).out).toContain("BLUE");
    rmSync(join(vardo, "apps/vardo/production/current"));
    symlinkSync("green", join(vardo, "apps/vardo/production/current"));
    expect(run(vardo, bin).out).toContain("GREEN");
  });

  it("falls back to the legacy slot, then the flat install", () => {
    const vardo = vardoDir();
    fakeCli(join(vardo, "apps/vardo/env/blue/scripts/vardo-cli.sh"), "LEGACY");
    symlinkSync("blue", join(vardo, "apps/vardo/env/current"));
    fakeCli(join(vardo, "scripts/vardo-cli.sh"), "FLAT");
    const bin = install(vardo);
    expect(run(vardo, bin).out).toContain("LEGACY");
    rmSync(join(vardo, "apps/vardo/env"), { recursive: true });
    expect(run(vardo, bin).out).toContain("FLAT");
  });

  it("skips a slot without the CLI instead of failing", () => {
    const vardo = vardoDir();
    mkdirSync(join(vardo, "apps/vardo/production/blue"), { recursive: true });
    symlinkSync("blue", join(vardo, "apps/vardo/production/current"));
    fakeCli(join(vardo, "scripts/vardo-cli.sh"), "FLAT");
    expect(run(vardo, install(vardo)).out).toContain("FLAT");
  });

  it("errors clearly when no CLI exists", () => {
    const vardo = vardoDir();
    const r = run(vardo, install(vardo));
    expect(r.status).toBe(1);
    expect(r.out).toContain("scripts/vardo-cli.sh not found");
    expect(r.out).toContain(vardo);
  });

  it("is replaced through a temp file and left executable", () => {
    const vardo = vardoDir();
    const bin = install(vardo);
    const first = statSync(bin).ino;
    install(vardo);
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(statSync(bin).ino).not.toBe(first);
    expect(readdirSync(vardo).filter((f) => f.startsWith("bin-vardo."))).toEqual([]);
  });

  it("writes nothing on a dry run", () => {
    const vardo = vardoDir();
    const bin = join(vardo, "bin-vardo");
    spawnSync("bash", ["-c", `source "${lib}"\nDRY_RUN=true\ninstall_shortcut`], { env: { ...process.env, VARDO_DIR: vardo, VARDO_BIN: bin } });
    expect(existsSync(bin)).toBe(false);
  });
});

describe("scripts/vardo-cli.sh", () => {
  it("is executable and parses", () => {
    expect(statSync(join(ROOT, "scripts/vardo-cli.sh")).mode & 0o111).not.toBe(0);
    expect(spawnSync("bash", ["-n", join(ROOT, "scripts/vardo-cli.sh")]).status).toBe(0);
  });

  it("refuses to run without VARDO_DIR", () => {
    const env = { ...process.env };
    delete env.VARDO_DIR;
    const r = spawnSync("bash", [join(ROOT, "scripts/vardo-cli.sh"), "help"], { encoding: "utf8", env });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("VARDO_DIR");
  });

  it("prints the help the heredoc wrapper printed", () => {
    chmodSync(join(ROOT, "scripts/vardo-cli.sh"), 0o755);
    const r = spawnSync("bash", [join(ROOT, "scripts/vardo-cli.sh"), "help"], { encoding: "utf8", env: { ...process.env, VARDO_DIR: "/nonexistent" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatchInlineSnapshot(`
      "Usage: vardo <command>

      Commands:
        logs [service]   View logs (follows); logs worker for background work
        worker status    Show the worker's container state and health
        restart          Restart all services
        stop             Stop all services
        start            Start all services
        ps               Show running containers
        update           Redeploy Vardo (a legacy install offers to migrate first)
        migrate-self-deploy  Move a legacy install onto Vardo's own deploy engine
        doctor           Run health checks
        key              Print the master key and auth secret (escrow them)
        key set          Load escrowed secrets (fresh installs, before a restore)
        setup-token      Print the first-run setup token
        adopt <path>     Onboard existing repo with vardo.yaml
        backup key       Print the age key that opens backup archives
        import-data <org>/<app> <volume> <source> [db]  Load a dump or volume tar into an app
        shell [cmd]      Open shell in frontend container
        uninstall        Remove Vardo
      "
    `);
  });
});
