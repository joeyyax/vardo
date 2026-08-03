import { describe, expect, it } from "vitest";
import { parseCompose } from "@/lib/docker/compose-parse";
import { volumeSharedServices } from "@/lib/docker/volume-shared";
import { nonRotatingServices, partitionBySlot } from "@/lib/docker/slot-partition";
import { sharedNetworks } from "@/lib/docker/shared-networks";
import { volumesByOwner } from "@/lib/docker/shared-volumes";

/** The shape that took GlitchTip down: postgres rotated onto one data directory. */
const UNMARKED = `services:
  web:
    image: glitchtip/glitchtip:latest
    volumes:
      - uploads:/code/uploads
  postgres:
    image: postgres:17
    volumes:
      - postgres-data:/var/lib/postgresql/data
volumes:
  uploads: {}
  postgres-data: {}
`;

describe("volumeSharedServices", () => {
  it("catches a stateful service holding a named volume with no marker", () => {
    expect([...volumeSharedServices(parseCompose(UNMARKED))]).toEqual(["postgres"]);
  });

  it("catches the same service when it is already marked — the marker is a separate question", () => {
    const marked = UNMARKED.replace("image: postgres:17", "image: postgres:17\n    x-vardo-shared: true");
    expect([...volumeSharedServices(parseCompose(marked))]).toEqual(["postgres"]);
  });

  it("leaves a stateless service alone, named volume or not", () => {
    expect(volumeSharedServices(parseCompose(UNMARKED))).not.toContain("web");
  });

  it("leaves a bind mount alone — the host path is not a volume Vardo externalizes", () => {
    const bind = parseCompose(`services:
  web:
    image: app
  postgres:
    image: postgres:17
    volumes:
      - /mnt/docker/app/postgres:/var/lib/postgresql/data
volumes:
  uploads: {}
`);
    expect(volumeSharedServices(bind).size).toBe(0);
  });

  it("leaves an anonymous volume alone — each slot gets its own copy", () => {
    const anon = parseCompose(`services:
  web:
    image: app
  postgres:
    image: postgres:17
    volumes:
      - /var/lib/postgresql/data
volumes:
  uploads: {}
`);
    expect(anon.services.postgres.volumes).toEqual(["/var/lib/postgresql/data"]);
    expect(volumeSharedServices(anon).size).toBe(0);
  });

  it("leaves a mount naming no top-level volume alone", () => {
    const undeclared = parseCompose(`services:
  web:
    image: app
  postgres:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  uploads: {}
`);
    expect(volumeSharedServices(undeclared).size).toBe(0);
  });

  it("leaves a service this deploy builds alone — shipping it is the point", () => {
    const built = parseCompose(`services:
  web:
    image: app
  postgres:
    build: ./db
    image: postgres:17
    volumes:
      - postgres-data:/var/lib/postgresql/data
volumes:
  postgres-data: {}
`);
    expect(volumeSharedServices(built).size).toBe(0);
  });
});

describe("nonRotatingServices", () => {
  it("adds a detected service to the marked ones", () => {
    expect([...nonRotatingServices(parseCompose(UNMARKED))]).toEqual(["postgres"]);
  });

  it("counts a marked-and-detected service once", () => {
    const marked = UNMARKED.replace("image: postgres:17", "image: postgres:17\n    x-vardo-shared: true");
    expect([...nonRotatingServices(parseCompose(marked))]).toEqual(["postgres"]);
  });

  it("promotes nothing when it would leave no service to deploy", () => {
    const only = parseCompose(`services:
  postgres:
    image: postgres:17
    volumes:
      - postgres-data:/var/lib/postgresql/data
volumes:
  postgres-data: {}
`);
    expect(nonRotatingServices(only).size).toBe(0);
  });

  it("drops a candidate that depends on a service still rotating", () => {
    const dependent = parseCompose(`services:
  web:
    image: app
  postgres:
    image: postgres:17
    depends_on:
      - web
    volumes:
      - postgres-data:/var/lib/postgresql/data
volumes:
  postgres-data: {}
`);
    expect(nonRotatingServices(dependent).size).toBe(0);
  });

  it("keeps a candidate depending only on another candidate", () => {
    const chained = parseCompose(`services:
  web:
    image: app
  postgres:
    image: postgres:17
    depends_on:
      - mongo
    volumes:
      - postgres-data:/var/lib/postgresql/data
  mongo:
    image: mongo:7
    volumes:
      - mongo-data:/data/db
volumes:
  postgres-data: {}
  mongo-data: {}
`);
    expect([...nonRotatingServices(chained)].sort()).toEqual(["mongo", "postgres"]);
  });
});

describe("partitionBySlot with a detected service", () => {
  it("keeps it out of the rotating set", () => {
    const { shared, slotted } = partitionBySlot(parseCompose(UNMARKED));
    expect(Object.keys(shared)).toEqual(["postgres"]);
    expect(Object.keys(slotted)).toEqual(["web"]);
  });

  it("strips the rotating side's depends_on, which the two projects cannot express", () => {
    const withDep = parseCompose(`services:
  web:
    image: app
    depends_on:
      - postgres
  postgres:
    image: postgres:17
    volumes:
      - postgres-data:/var/lib/postgresql/data
volumes:
  postgres-data: {}
`);
    expect(partitionBySlot(withDep).slotted.web.depends_on).toBeUndefined();
  });
});

describe("volume naming under detection", () => {
  it("leaves a detected service's volume externalized, where its data already is", () => {
    expect(volumesByOwner(parseCompose(UNMARKED)).sharedOnly.size).toBe(0);
  });

  it("still claims a marked service's volume", () => {
    const marked = UNMARKED.replace("image: postgres:17", "image: postgres:17\n    x-vardo-shared: true");
    expect([...volumesByOwner(parseCompose(marked)).sharedOnly]).toEqual(["postgres-data"]);
  });
});

describe("sharedNetworks with a detected service", () => {
  it("claims the implicit default, without which nothing can reach the database", () => {
    expect([...sharedNetworks(parseCompose(UNMARKED))]).toEqual(["default"]);
  });

  it("leaves the default alone when the shared service names its own networks", () => {
    const named = parseCompose(`services:
  web:
    image: app
    networks: [internal]
  postgres:
    image: postgres:17
    networks: [internal]
    volumes:
      - postgres-data:/var/lib/postgresql/data
volumes:
  postgres-data: {}
networks:
  internal:
`);
    expect([...sharedNetworks(named)]).toEqual(["internal"]);
  });

  it("leaves an externally declared default alone", () => {
    const external = parseCompose(`${UNMARKED}networks:
  default:
    external: true
`);
    expect(sharedNetworks(external).size).toBe(0);
  });
});
