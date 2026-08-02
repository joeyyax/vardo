import { describe, it, expect, vi } from "vitest";
import { readSlotPartition, sharedScopeArgs } from "@/lib/docker/shared-project";
import { slotScopeArgs } from "@/lib/docker/slot-partition";

const SLOT_DIR = "/opt/vardo/apps/paperless/production/blue";

const WITH_SHARED = `
services:
  web:
    image: paperless:1
    depends_on:
      - db
  db:
    image: postgres:17
    x-vardo-shared: true
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data: {}
`;

const NO_SHARED = `
services:
  web:
    image: paperless:1
  worker:
    image: paperless:1
`;

function reader(yaml: string) {
  return vi.fn(() => Promise.resolve(yaml));
}

describe("readSlotPartition", () => {
  it("splits a slot compose that declares a shared service", async () => {
    const partition = await readSlotPartition(SLOT_DIR, reader(WITH_SHARED));
    expect(Object.keys(partition!.shared)).toEqual(["db"]);
    expect(Object.keys(partition!.slotted)).toEqual(["web"]);
  });

  it("reads the compose from the slot directory", async () => {
    const read = reader(WITH_SHARED);
    await readSlotPartition(SLOT_DIR, read);
    expect(read).toHaveBeenCalledWith(`${SLOT_DIR}/docker-compose.yml`);
  });

  it("returns null when nothing is shared, so callers keep their single-project command", async () => {
    expect(await readSlotPartition(SLOT_DIR, reader(NO_SHARED))).toBeNull();
  });

  it("returns null when the slot has no compose on disk", async () => {
    const read = vi.fn(() => Promise.reject(new Error("ENOENT")));
    expect(await readSlotPartition(SLOT_DIR, read)).toBeNull();
  });

  it("returns null for unparseable YAML", async () => {
    expect(await readSlotPartition(SLOT_DIR, reader("not: a: compose"))).toBeNull();
  });

  it("returns null when every service is shared — there is no deployable split", async () => {
    const yaml = `
services:
  db:
    image: postgres:17
    x-vardo-shared: true
`;
    expect(await readSlotPartition(SLOT_DIR, reader(yaml))).toBeNull();
  });
});

describe("scope args from a slot partition", () => {
  it("confines a command to the rotating services", async () => {
    const partition = await readSlotPartition(SLOT_DIR, reader(WITH_SHARED));
    expect(slotScopeArgs(partition!)).toEqual(["--no-deps", "web"]);
  });

  it("confines a command to the shared services", async () => {
    const partition = await readSlotPartition(SLOT_DIR, reader(WITH_SHARED));
    expect(sharedScopeArgs(partition!)).toEqual(["--no-deps", "db"]);
  });
});
