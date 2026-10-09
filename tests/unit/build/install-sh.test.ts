import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// install.sh with its final `main "$@"` removed, so its functions can be called one at a time.

let dir: string;
let lib: string;
let repo: string;
let tipSha: string;
let oldSha: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Runs a snippet with install.sh's functions loaded. */
function sh(script: string, env: Record<string, string> = {}, path = process.env.PATH ?? "") {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${lib}"\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: path, VARDO_REF: "", VARDO_DIR: join(dir, "absent"), ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "install-sh-"));
  lib = join(dir, "install-lib.sh");
  const src = readFileSync(join(__dirname, "../../../install.sh"), "utf8").trimEnd().split("\n");
  expect(src.at(-1)).toBe('main "$@"');
  writeFileSync(lib, src.slice(0, -1).join("\n"));

  repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f"), "one");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  oldSha = git(repo, "rev-parse", "HEAD");
  git(repo, "tag", "v1");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "f"), "two");
  git(repo, "commit", "-qam", "two");
  tipSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function clone(ref: string | null, name: string) {
  const dest = join(dir, name);
  const r = sh(`REPO_URL="file://${repo}"\nclone_ref "${dest}"\ngit -C "${dest}" rev-parse HEAD`, ref ? { VARDO_REF: ref } : {});
  return { ...r, sha: r.out.trim().split("\n").at(-1) };
}

describe("VARDO_REF", () => {
  it("defaults to main", () => {
    expect(sh('echo "$VARDO_REF $VARDO_REF_SET"').out.trim()).toBe("main false");
  });

  it("is marked as set when given", () => {
    expect(sh('echo "$VARDO_REF $VARDO_REF_SET"', { VARDO_REF: "feature" }).out.trim()).toBe("feature true");
  });

  it("clones main by default", () => {
    expect(clone(null, "c-main").sha).toBe(oldSha);
  });

  it("clones a branch", () => {
    expect(clone("feature", "c-branch").sha).toBe(tipSha);
  });

  it("clones a tag", () => {
    expect(clone("v1", "c-tag").sha).toBe(oldSha);
  });

  it("fetches a commit sha", () => {
    expect(clone(tipSha, "c-tip").sha).toBe(tipSha);
    expect(clone(oldSha, "c-old").sha).toBe(oldSha);
  });

  it("resolves a short sha on any branch", () => {
    expect(clone(tipSha.slice(0, 8), "c-short-tip").sha).toBe(tipSha);
    expect(clone(oldSha.slice(0, 7), "c-short-old").sha).toBe(oldSha);
  });

  it("moves a shallow checkout to a short sha", () => {
    const dest = join(dir, "c-move-short");
    const r = sh(
      `REPO_URL="file://${repo}"\nVARDO_REF=feature clone_ref "${dest}"\ncd "${dest}"\nVARDO_REF=${oldSha.slice(0, 8)} checkout_ref\ngit rev-parse HEAD`,
    );
    expect(r.status).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe(oldSha);
  });

  it("fails clearly on a short sha that matches nothing", () => {
    const r = clone("deadbeef", "c-short-missing");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Could not fetch deadbeef");
    expect(r.out).not.toContain("couldn't find remote ref");
  });

  it("fails on a ref that does not exist", () => {
    const r = clone("nope", "c-missing");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Could not fetch nope");
  });

  it("moves an existing checkout to the ref", () => {
    const dest = join(dir, "c-move");
    const r = sh(
      `REPO_URL="file://${repo}"\nVARDO_REF=main clone_ref "${dest}"\ncd "${dest}"\nVARDO_REF=feature checkout_ref\ngit rev-parse HEAD\ngit branch --show-current`,
    );
    expect(r.out.trim().split("\n").slice(-2)).toEqual([tipSha, "feature"]);
  });

  it.each(["--upload-pack=x", "a..b", "-f", "a b", "/etc"])("rejects %s", (ref) => {
    const r = sh("validate_ref", { VARDO_REF: ref });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Invalid VARDO_REF");
  });

  it.each(["main", "v1.2.3", "release/2.x", "c47d9d52"])("accepts %s", (ref) => {
    expect(sh("validate_ref", { VARDO_REF: ref }).status).toBe(0);
  });
});

describe("package step without a terminal", () => {
  const script = `has_tty() { return 1; }\npkg_check() { return 1; }\nPKG_MGR=apt\ninstall_packages_linux`;

  it("tells the operator to rerun with --yes", () => {
    const r = sh(script);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Rerun with --yes");
  });
});

describe("rerun after a failed install", () => {
  /** A docker whose `ps --filter publish=N` names the container for each listed port. */
  function fakeDocker(name: string, published: Record<string, string>) {
    const bin = join(dir, `bin-${name}`);
    mkdirSync(bin, { recursive: true });
    const cases = Object.entries(published).map(([p, n]) => `*publish=${p}\\ *) echo ${n};;`).join(" ");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\ncase "$*" in ${cases} esac\n`);
    chmodSync(join(bin, "docker"), 0o755);
    return `${bin}:${process.env.PATH}`;
  }

  const ports = `check_port_in_use() { [ "$1" = 80 ] || [ "$1" = 443 ]; }\nget_port_process() { echo nginx; }\nVARDO_ROLE=production\ncheck_ports`;

  it("continues when vardo-traefik holds ports 80 and 443", () => {
    const r = sh(ports, {}, fakeDocker("both", { 80: "vardo-traefik", 443: "vardo-traefik" }));
    expect(r.status).toBe(0);
    expect(r.out).toContain("Port 80 is held by vardo-traefik");
    expect(r.out).toContain("Port 443 is held by vardo-traefik");
  });

  it("still refuses a port vardo-traefik does not hold", () => {
    const r = sh(ports, {}, fakeDocker("only80", { 80: "vardo-traefik" }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Port 80 is held by vardo-traefik");
    expect(r.out).toContain("Port 443 is in use by nginx");
  });

  it("refuses when another process holds the port", () => {
    const r = sh(ports, {}, fakeDocker("other", { 8080: "vardo-traefik" }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Port 80 is in use by nginx");
  });

  it("numbers Configuration among the steps when .env already exists", () => {
    mkdirSync(join(dir, "vardo-home"), { recursive: true });
    writeFileSync(join(dir, "vardo-home", ".env"), "X=1\n");
    const r = sh("STEP_TOTAL=5\nSTEP_CURRENT=3\ngenerate_env", { VARDO_DIR: join(dir, "vardo-home") });
    expect(r.out).toContain("[4/5] Configuration");
  });

  it("announces five steps, seven with --restore", () => {
    expect(sh("install_step_total").out.trim()).toBe("5");
    expect(sh("RESTORE=true\ninstall_step_total").out.trim()).toBe("7");
  });

  describe("service ports", () => {
    const svc = (busy: string) =>
      `check_port_in_use() { case " ${busy} " in *" $1 "*) return 0;; *) return 1;; esac; }\nVARDO_ROLE=development\ncheck_ports\necho "PG=${"$"}{POSTGRES_PORT:-unset} REDIS=${"$"}{REDIS_PORT:-unset} CAD=${"$"}{CADVISOR_PORT:-unset} LOKI=${"$"}{LOKI_PORT:-unset}"`;

    it("keeps a port its own container holds", () => {
      const path = fakeDocker("own", { 7100: "vardo-postgres", 7200: "vardo-redis", 7300: "vardo-cadvisor-1", 7400: "myproj-loki" });
      const r = sh(svc("7100 7200 7300 7400"), {}, path);
      expect(r.status).toBe(0);
      expect(r.out).toContain("PG=unset REDIS=unset CAD=unset LOKI=unset");
      expect(r.out).not.toContain("reassigning");
    });

    it("keeps the port written to .env, not the default", () => {
      const home = join(dir, "vardo-svc");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".env"), "POSTGRES_PORT=7101\n");
      const path = fakeDocker("env", { 7101: "vardo-postgres" });
      const r = sh(svc("7101"), { VARDO_DIR: home }, path);
      expect(r.status).toBe(0);
      expect(r.out).toContain("port 7101 is held by its own container");
      expect(r.out).toContain("PG=unset");
    });

    it("does not reassign a port set in .env when something else holds it", () => {
      const home = join(dir, "vardo-svc2");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".env"), "REDIS_PORT=7201\n");
      const r = sh(svc("7201"), { VARDO_DIR: home }, fakeDocker("foreign", { 7201: "nginx" }));
      expect(r.out).toContain("not reassigning");
      expect(r.out).toContain("REDIS=unset");
    });

    it("still reassigns a fresh install's port held by a stranger", () => {
      const r = sh(svc("7100"), { VARDO_DIR: join(dir, "no-such-dir") }, fakeDocker("stranger", { 7100: "nginx" }));
      expect(r.out).toContain("PostgreSQL: port 7100 in use");
      expect(r.out).toContain("PG=7101");
    });
  });
});

describe("install-time options", () => {
  const TOKEN = "cfut_SECRETtokenVALUE0123456789abcdef";
  const home = () => {
    const d = mkdtempSync(join(dir, "opts-"));
    return d;
  };
  const apply = (envFile: string, extra = "") => `${extra}\napply_install_options "${envFile}"\ncat "${envFile}"`;

  it("writes all four on a fresh install", () => {
    const d = home();
    const r = sh(
      `VARDO_ROLE=development\nUNATTENDED=true\nvalidate_install_options\ngenerate_env\ncat "$VARDO_DIR/.env"`,
      {
        VARDO_DIR: d,
        CF_DNS_API_TOKEN: TOKEN,
        VARDO_TRUSTED_PROXIES: "10.90.0.2, 10.1.0.0/16",
        VARDO_CONSOLE_MIDDLEWARES: "cloudflare-only@file",
        VARDO_CONSOLE_CERT_RESOLVER: "le-dns",
      },
    );
    expect(r.status).toBe(0);
    const env = readFileSync(join(d, ".env"), "utf8");
    expect(env).toContain(`CF_DNS_API_TOKEN=${TOKEN}`);
    expect(env).toContain("VARDO_TRUSTED_PROXIES=10.90.0.2,10.1.0.0/16");
    expect(env).toContain("VARDO_CONSOLE_MIDDLEWARES=cloudflare-only@file");
    expect(env).toContain("VARDO_CONSOLE_CERT_RESOLVER=le-dns");
  });

  it("adds missing values on update and keeps existing ones", () => {
    const d = home();
    const f = join(d, ".env");
    writeFileSync(f, "VARDO_TRUSTED_PROXIES=10.0.0.1\n");
    const r = sh(apply(f), { VARDO_TRUSTED_PROXIES: "10.9.9.9", VARDO_CONSOLE_CERT_RESOLVER: "le-dns" });
    expect(r.status).toBe(0);
    const env = readFileSync(f, "utf8");
    expect(env).toContain("VARDO_TRUSTED_PROXIES=10.0.0.1");
    expect(env).not.toContain("10.9.9.9");
    expect(env).toContain("VARDO_CONSOLE_CERT_RESOLVER=le-dns");
    expect(r.out).toContain("--set VARDO_TRUSTED_PROXIES=VALUE");
  });

  it("changes nothing when no option is given", () => {
    const d = home();
    const f = join(d, ".env");
    writeFileSync(f, "X=1\n");
    sh(apply(f));
    expect(readFileSync(f, "utf8")).toBe("X=1\n");
  });

  it("replaces an existing value only with --set", () => {
    const d = home();
    const f = join(d, ".env");
    writeFileSync(f, "VARDO_TRUSTED_PROXIES=10.0.0.1\nVARDO_CONSOLE_CERT_RESOLVER=old\n");
    const r = sh(apply(f, 'parse_args --set VARDO_TRUSTED_PROXIES=10.9.9.9 --console-cert-resolver le-dns'));
    expect(r.status).toBe(0);
    const env = readFileSync(f, "utf8");
    expect(env).toContain("VARDO_TRUSTED_PROXIES=10.9.9.9");
    expect(env).toContain("VARDO_CONSOLE_CERT_RESOLVER=old");
  });

  it("takes flags in both forms", () => {
    const r = sh(
      'parse_args --trusted-proxies=10.0.0.5 --console-middlewares tailscale-only@file\necho "$VARDO_TRUSTED_PROXIES|$VARDO_CONSOLE_MIDDLEWARES"',
    );
    expect(r.out.trim().split("\n").at(-1)).toBe("10.0.0.5|tailscale-only@file");
  });

  it("refuses --set for any other key", () => {
    const r = sh("parse_args --set DB_PASSWORD=x");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Unknown option DB_PASSWORD");
  });

  it.each([
    ["VARDO_TRUSTED_PROXIES", "10.0.0.256"],
    ["VARDO_TRUSTED_PROXIES", "10.0.0.0/33"],
    ["VARDO_TRUSTED_PROXIES", "10.0.0.1,not-an-ip"],
    ["VARDO_TRUSTED_PROXIES", "example.com"],
    ["VARDO_CONSOLE_MIDDLEWARES", "cloudflare-only"],
    ["VARDO_CONSOLE_MIDDLEWARES", "a@file,b"],
    ["VARDO_CONSOLE_CERT_RESOLVER", "le dns"],
    ["CF_DNS_API_TOKEN", "short"],
  ])("refuses %s=%s", (key, value) => {
    const r = sh("validate_install_options", { [key]: value });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(key);
  });

  it.each(["10.90.0.2", "10.1.0.0/16", "fd7a:115c:a1e0::/48", "::1", "10.0.0.1,2001:db8::1"])("accepts proxies %s", (v) => {
    expect(sh("validate_install_options", { VARDO_TRUSTED_PROXIES: v }).status).toBe(0);
  });

  it("never prints the token", () => {
    const d = home();
    const f = join(d, ".env");
    writeFileSync(f, "");
    const ok = sh(apply(f, "validate_install_options").replace(`cat "${f}"`, ""), { CF_DNS_API_TOKEN: TOKEN });
    expect(ok.out).toContain("Set CF_DNS_API_TOKEN");
    expect(ok.out).not.toContain(TOKEN);
    const kept = sh(`apply_install_options "${f}"`, { CF_DNS_API_TOKEN: TOKEN });
    expect(kept.out).not.toContain(TOKEN);
    const bad = sh("validate_install_options", { CF_DNS_API_TOKEN: "bad token with spaces " + TOKEN });
    expect(bad.status).not.toBe(0);
    expect(bad.out).not.toContain(TOKEN);
    const help = spawnSync("bash", [join(__dirname, "../../../install.sh"), "--help"], { encoding: "utf8", env: { ...process.env, CF_DNS_API_TOKEN: TOKEN } });
    expect(help.stdout).not.toContain(TOKEN);
  });
});

describe(".env permissions", () => {
  const asRoot = 'id() { echo 0; }\nchown() { echo "chown $*"; }\n';
  const mode = (f: string) => (statSync(f).mode & 0o777).toString(8);
  const home = (name: string) => {
    const d = join(dir, `perms-${name}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".env"), "X=1\n");
    chmodSync(join(d, ".env"), 0o600);
    return d;
  };

  it("hands .env to group 1001 when run as root", () => {
    const f = join(home("root"), ".env");
    const r = sh(`${asRoot}secure_env_file "${f}"`);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`chown 0:1001 ${f}`);
    expect(mode(f)).toBe("660");
  });

  it("keeps .env private to its owner otherwise", () => {
    const f = join(home("user"), ".env");
    chmodSync(f, 0o644);
    expect(sh(`secure_env_file "${f}"`).status).toBe(0);
    expect(mode(f)).toBe("600");
  });

  it.each(["run_env_migrations", "generate_env"])("repairs an existing install's .env in %s", (fn) => {
    const d = home(fn);
    const r = sh(`${asRoot}${fn}`, { VARDO_DIR: d });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`chown 0:1001 ${d}/.env`);
    expect(mode(join(d, ".env"))).toBe("660");
  });
});

describe("Docker daemon config", () => {
  /** Runs configure_docker_logging against a daemon.json under the test dir. */
  function configure(name: string, existing?: string) {
    const etc = join(dir, name);
    const daemon = join(etc, "daemon.json");
    mkdirSync(etc, { recursive: true });
    if (existing !== undefined) writeFileSync(daemon, existing);
    const local = join(dir, `${name}.sh`);
    writeFileSync(local, readFileSync(lib, "utf8").replaceAll("/etc/docker", etc));
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\nsource "${local}"\nPLATFORM=linux\nsystemctl() { :; }\ndocker() { :; }\nconfigure_docker_logging`],
      { encoding: "utf8", env: { ...process.env, VARDO_REF: "", VARDO_DIR: join(dir, "absent") } },
    );
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(readFileSync(daemon, "utf8"));
  }

  it("writes /24 address pools on a host with no daemon.json", () => {
    const config = configure("fresh");
    expect(config["log-opts"]).toEqual({ "max-size": "10m", "max-file": "3" });
    expect(config["default-address-pools"]).toContainEqual({ base: "172.17.0.0/16", size: 24 });
    expect(config["default-address-pools"].every((p: { size: number }) => p.size === 24)).toBe(true);
  });

  it("leaves an existing daemon.json's networking alone", () => {
    const config = configure("existing", JSON.stringify({ "data-root": "/srv/docker" }));
    expect(config["data-root"]).toBe("/srv/docker");
    expect(config["log-driver"]).toBe("json-file");
    expect(config).not.toHaveProperty("default-address-pools");
  });
});
