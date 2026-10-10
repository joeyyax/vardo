import { describe, expect, it } from "vitest";
import { parseCompose } from "@/lib/docker/compose-parse";
import { volumeSharedServices } from "@/lib/docker/volume-shared";
import {
  nonRotatingServices,
  partitionBySlot,
  slotOverlapDiagnosis,
} from "@/lib/docker/slot-partition";
import { ownsDataDirectory, isMajorLocked } from "@/lib/docker/image-updates/stateful-image";

/**
 * notes-api as deployed on 10.0.0.19, which failed to deploy for six
 * weeks: meilisearch held the LMDB lock from the old slot, never went healthy,
 * and took the slot down through depends_on.
 */
const NOTES_API = `services:
  notes-api:
    build: .
    volumes:
      - /mnt/docker/notes-api/content:/data/content
      - /mnt/docker/notes-api/usage:/data/usage
    depends_on:
      notes-search:
        condition: service_healthy
  notes-search:
    image: getmeili/meilisearch:v1.16
    volumes:
      - /mnt/docker/notes-api/meili-data:/meili_data
`;

describe("notes-api, the compose that failed", () => {
  it("takes meilisearch out of the rotation", () => {
    expect([...volumeSharedServices(parseCompose(NOTES_API))]).toEqual(["notes-search"]);
    expect([...nonRotatingServices(parseCompose(NOTES_API))]).toEqual(["notes-search"]);
  });

  it("leaves the app's own build service in it, /data mount and all", () => {
    const { shared, slotted } = partitionBySlot(parseCompose(NOTES_API));
    expect(Object.keys(shared)).toEqual(["notes-search"]);
    expect(Object.keys(slotted)).toEqual(["notes-api"]);
  });

  it("drops the depends_on the two compose projects cannot express", () => {
    const { slotted } = partitionBySlot(parseCompose(NOTES_API));
    expect(slotted["notes-api"].depends_on).toBeUndefined();
  });
});

describe("ownsDataDirectory — engines that lock their data directory", () => {
  it("catches the ones added for the meilisearch failure", () => {
    for (const image of [
      "getmeili/meilisearch:v1.16",
      "qdrant/qdrant:v1.12.4",
      "typesense/typesense:27.1",
      "clickhouse/clickhouse-server:24.8",
      "couchdb:3.4",
      "quay.io/coreos/etcd:v3.5.17",
      "surrealdb/surrealdb:v2.1.4",
      "solr:9.7",
      "neo4j:5.26",
      "cassandra:5.0",
    ]) {
      expect(ownsDataDirectory(image), image).toBe(true);
    }
  });

  it("leaves an application image alone", () => {
    for (const image of [
      "getoutline/outline:0.82.0",
      "ghcr.io/paperless-ngx/paperless-ngx:2.20.15",
      "nginx:alpine",
      "traefik:v3.3",
    ]) {
      expect(ownsDataDirectory(image), image).toBe(false);
    }
  });

  it("gates a major bump only for the store formats a major migrates", () => {
    expect(isMajorLocked("neo4j:5.26")).toBe(true);
    expect(isMajorLocked("cassandra:5.0")).toBe(true);
    expect(isMajorLocked("getmeili/meilisearch:v1.16")).toBe(false);
    expect(isMajorLocked("qdrant/qdrant:v1.12.4")).toBe(false);
  });
});

describe("volumeSharedServices — the added data directories", () => {
  const cases: [string, string, string][] = [
    ["search", "getmeili/meilisearch:v1.16", "/mnt/d/meili:/meili_data"],
    ["vectors", "qdrant/qdrant:v1.12.4", "/mnt/d/qdrant:/qdrant/storage"],
    ["olap", "clickhouse/clickhouse-server:24.8", "/mnt/d/ch:/var/lib/clickhouse"],
    ["docs", "couchdb:3.4", "/mnt/d/couch:/opt/couchdb/data"],
    ["ring", "cassandra:5.0", "/mnt/d/cass:/var/lib/cassandra"],
    ["index", "solr:9.7", "/mnt/d/solr:/var/solr"],
    ["registry", "quay.io/coreos/etcd:v3.5.17", "/mnt/d/etcd:/etcd-data"],
    ["graph", "neo4j:5.26", "/mnt/d/neo4j:/data"],
  ];

  it.each(cases)("catches %s on a host path", (name, image, mount) => {
    const compose = parseCompose(`services:
  web:
    image: app
  ${name}:
    image: ${image}
    volumes:
      - ${mount}
`);
    expect([...volumeSharedServices(compose)]).toEqual([name]);
  });

  it("catches the same engines on a named volume", () => {
    const compose = parseCompose(`services:
  web:
    image: app
  search:
    image: getmeili/meilisearch:v1.16
    volumes:
      - meili:/meili_data
  vectors:
    image: qdrant/qdrant:v1.12.4
    volumes:
      - qdrant:/qdrant/storage
volumes:
  meili: {}
  qdrant: {}
`);
    expect([...volumeSharedServices(compose)].sort()).toEqual(["search", "vectors"]);
  });

  it("leaves a meilisearch config mount alone", () => {
    const compose = parseCompose(`services:
  web:
    image: app
  search:
    image: getmeili/meilisearch:v1.16
    volumes:
      - /mnt/d/meili.toml:/etc/meilisearch.toml
      - /mnt/d/snapshots:/snapshots
`);
    expect(volumeSharedServices(compose).size).toBe(0);
  });

  it("leaves a meilisearch with nothing persisted alone", () => {
    const compose = parseCompose(`services:
  web:
    image: app
  search:
    image: getmeili/meilisearch:v1.16
`);
    expect(volumeSharedServices(compose).size).toBe(0);
  });
});

describe("slotOverlapDiagnosis", () => {
  /** An engine detection does not recognize, so promotion never happens. */
  const UNRECOGNIZED = parseCompose(`services:
  web:
    image: app
  search:
    image: ghcr.io/acme/vectorstore:3
    volumes:
      - /mnt/docker/app/store:/data
`);

  it("names the service, its mount and the marker", () => {
    const { slotted } = partitionBySlot(UNRECOGNIZED);
    const hint = slotOverlapDiagnosis(UNRECOGNIZED, slotted, true);
    expect(hint).toContain("search");
    expect(hint).toContain("/mnt/docker/app/store:/data");
    expect(hint).toContain("x-vardo-shared: true");
  });

  it("says nothing when the slots did not overlap", () => {
    const { slotted } = partitionBySlot(UNRECOGNIZED);
    expect(slotOverlapDiagnosis(UNRECOGNIZED, slotted, false)).toBeNull();
  });

  it("says nothing when no rotating service reaches past its slot", () => {
    const plain = parseCompose(`services:
  web:
    image: app
    volumes:
      - ./config:/etc/app
  sidecar:
    image: nginx
`);
    expect(slotOverlapDiagnosis(plain, partitionBySlot(plain).slotted, true)).toBeNull();
  });

  it("says nothing about a service already taken out of the rotation", () => {
    const compose = parseCompose(NOTES_API);
    const { slotted } = partitionBySlot(compose);
    expect(slotOverlapDiagnosis(compose, slotted, true)).toBeNull();
  });

  it("says nothing about a build service's content directory, shared on purpose", () => {
    const built = parseCompose(`services:
  web:
    build: .
    volumes:
      - /mnt/docker/app/uploads:/data/uploads
`);
    expect(slotOverlapDiagnosis(built, partitionBySlot(built).slotted, true)).toBeNull();
  });
});
