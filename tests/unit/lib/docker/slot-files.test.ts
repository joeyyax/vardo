import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  isVardoLegacyOverlay,
  slotComposeFiles,
  slotEnvFileArgs,
  slotVars,
  writeSlotVars,
} from "@/lib/docker/slot-files";

const SHA = "0123456789abcdef0123456789abcdef01234567";

// What Vardo wrote as docker-compose.vardo.yml before the overlay moved to docker-compose.override.yml.
const LEGACY_OVERLAY = `services:
  web:
    labels:
      traefik.enable: "true"
      traefik.http.routers.blog-web.rule: Host(\`blog.example.com\`)
    networks:
      - vardo-network
    deploy:
      resources:
        limits:
          memory: 512M
  worker: {}
networks:
  vardo-network:
    external: true
volumes:
  data:
    external: true
    name: blog-production_data
`;

// A repo's own file that happens to use the old overlay's name.
const REPO_FILE = `services:
  web:
    image: blog:latest
    environment:
      NODE_ENV: production
    networks:
      - vardo-network
networks:
  vardo-network:
    external: true
`;

let slot: string;

beforeEach(async () => {
  slot = await mkdtemp(join(tmpdir(), "vardo-slot-"));
  await writeFile(join(slot, "docker-compose.yml"), "services:\n  web:\n    image: blog\n");
});

afterEach(async () => {
  await rm(slot, { recursive: true, force: true });
});

describe("slotVars", () => {
  it("gives the full and short commit", () => {
    expect(slotVars(SHA)).toEqual({ VARDO_GIT_SHA: SHA, VARDO_GIT_SHORT_SHA: "0123456" });
  });

  it("falls back to local without a commit", () => {
    expect(slotVars(undefined)).toEqual({ VARDO_GIT_SHA: "local", VARDO_GIT_SHORT_SHA: "local" });
    expect(slotVars(null)).toEqual({ VARDO_GIT_SHA: "local", VARDO_GIT_SHORT_SHA: "local" });
  });

  it("never passes through something that isn't a commit", () => {
    expect(slotVars("main; rm -rf /").VARDO_GIT_SHA).toBe("local");
  });
});

describe("isVardoLegacyOverlay", () => {
  it("recognizes the overlay Vardo wrote", () => {
    expect(isVardoLegacyOverlay(LEGACY_OVERLAY)).toBe(true);
  });

  it("rejects a repo file with service config of its own", () => {
    expect(isVardoLegacyOverlay(REPO_FILE)).toBe(false);
  });

  it("rejects a labels-only file without the vardo-network declaration", () => {
    expect(isVardoLegacyOverlay("services:\n  web:\n    labels:\n      traefik.enable: \"true\"\n")).toBe(false);
  });

  it("rejects labels outside Vardo's prefixes", () => {
    expect(isVardoLegacyOverlay(LEGACY_OVERLAY.replace("traefik.enable", "com.example.team"))).toBe(false);
  });

  it("rejects YAML that doesn't parse", () => {
    expect(isVardoLegacyOverlay("services: [")).toBe(false);
  });
});

describe("slotComposeFiles", () => {
  const base = () => join(slot, "docker-compose.yml");
  const override = () => join(slot, "docker-compose.override.yml");
  const legacy = () => join(slot, "docker-compose.vardo.yml");

  it("uses Vardo's override", async () => {
    await writeFile(override(), LEGACY_OVERLAY);
    expect(await slotComposeFiles(slot)).toEqual(["-f", base(), "-f", override()]);
  });

  it("uses the base file alone without an overlay", async () => {
    expect(await slotComposeFiles(slot)).toEqual(["-f", base()]);
  });

  it("ignores a repo's own docker-compose.vardo.yml", async () => {
    await writeFile(override(), LEGACY_OVERLAY);
    await writeFile(legacy(), REPO_FILE);
    expect(await slotComposeFiles(slot)).toEqual(["-f", base(), "-f", override()]);
  });

  it("reads Vardo's legacy overlay in a slot from before the rename", async () => {
    await writeFile(legacy(), LEGACY_OVERLAY);
    expect(await slotComposeFiles(slot)).toEqual(["-f", base(), "-f", legacy()]);
  });

  it("prefers the legacy overlay over a repo override copied into an old slot", async () => {
    await writeFile(legacy(), LEGACY_OVERLAY);
    await writeFile(override(), REPO_FILE);
    expect(await slotComposeFiles(slot)).toEqual(["-f", base(), "-f", legacy()]);
  });

  it("skips a legacy name that isn't a readable file", async () => {
    await mkdir(legacy());
    await writeFile(override(), LEGACY_OVERLAY);
    expect(await slotComposeFiles(slot)).toEqual(["-f", base(), "-f", override()]);
  });

  it("adds the slot's env files after the compose files", async () => {
    await writeFile(override(), LEGACY_OVERLAY);
    await writeFile(join(slot, ".env"), "PORT=3000\n");
    await writeSlotVars(slot, SHA);
    expect(await slotComposeFiles(slot)).toEqual([
      "-f", base(), "-f", override(),
      "--env-file", join(slot, ".env"),
      "--env-file", join(slot, ".vardo.env"),
    ]);
  });
});

describe("slotEnvFileArgs", () => {
  it("is empty for a slot deployed before the variables existed", async () => {
    await writeFile(join(slot, ".env"), "PORT=3000\n");
    expect(await slotEnvFileArgs(slot)).toEqual([]);
  });

  it("passes only Vardo's variables when the slot has no .env", async () => {
    await writeSlotVars(slot, undefined);
    expect(await slotEnvFileArgs(slot)).toEqual(["--env-file", join(slot, ".vardo.env")]);
    expect(await readFile(join(slot, ".vardo.env"), "utf-8")).toBe("VARDO_GIT_SHA=local\nVARDO_GIT_SHORT_SHA=local\n");
  });
});
