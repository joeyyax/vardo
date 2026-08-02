import { describe, expect, it } from "vitest";
import {
  crossBoundaryVolumeName,
  sharedOnlyVolumes,
  volumesByOwner,
} from "@/lib/docker/shared-volumes";
import { parseCompose } from "@/lib/docker/compose-parse";

const SRC = `name: vardo
services:
  frontend:
    image: app
    volumes:
      - uploads:/data
  postgres:
    image: postgres:17
    x-vardo-shared: true
    volumes:
      - postgres_data:/var/lib/postgresql/data
  cache:
    image: redis
    x-vardo-shared: true
    volumes:
      - shared_scratch:/scratch
  worker:
    image: app
    volumes:
      - shared_scratch:/scratch
volumes:
  uploads:
  postgres_data:
  shared_scratch:
`;

describe("sharedOnlyVolumes", () => {
  it("claims a volume only shared services mount", () => {
    expect(sharedOnlyVolumes(parseCompose(SRC))).toContain("postgres_data");
  });

  it("leaves a rotating service's volume externalized", () => {
    expect(sharedOnlyVolumes(parseCompose(SRC))).not.toContain("uploads");
  });

  it("leaves a volume both sides mount externalized, since it outlives the slot", () => {
    expect(sharedOnlyVolumes(parseCompose(SRC))).not.toContain("shared_scratch");
  });

  it("claims nothing when no service is shared", () => {
    const plain = parseCompose(`services:
  web:
    image: app
    volumes:
      - data:/data
volumes:
  data:
`);
    expect(sharedOnlyVolumes(plain).size).toBe(0);
  });

  it("ignores the container path and mode when reading the mount", () => {
    const compose = parseCompose(`services:
  db:
    image: postgres
    x-vardo-shared: true
    volumes:
      - pgdata:/var/lib/postgresql/data:rw
  web:
    image: app
volumes:
  pgdata:
`);
    expect(sharedOnlyVolumes(compose)).toContain("pgdata");
  });
});

describe("crossBoundaryVolumeName", () => {
  it("uses the pinned project name, matching what the shared services already created", () => {
    const compose = parseCompose(SRC);
    expect(crossBoundaryVolumeName(compose, "shared_scratch", "vardo-production")).toBe(
      "vardo_shared_scratch",
    );
  });

  it("falls back to the app-and-environment prefix when nothing is pinned", () => {
    const compose = parseCompose(SRC.replace("name: vardo\n", ""));
    expect(crossBoundaryVolumeName(compose, "shared_scratch", "shop-production")).toBe(
      "shop-production_shared_scratch",
    );
  });
});

describe("volumesByOwner", () => {
  it("separates the volume both sides mount from the ones only shared services touch", () => {
    const { sharedOnly, crossBoundary } = volumesByOwner(parseCompose(SRC));
    expect([...sharedOnly].sort()).toEqual(["postgres_data"]);
    expect([...crossBoundary]).toEqual(["shared_scratch"]);
  });
});
