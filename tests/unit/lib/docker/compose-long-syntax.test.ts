import { describe, expect, it } from "vitest";
import { composeToYaml, parseCompose } from "@/lib/docker/compose-parse";

// Long-form volumes and ports, as Dokploy and `docker compose config` write them.
const SOURCE = `services:
  mail-smtp:
    image: example/smtp:1
    ports:
      - target: 587
        published: 587
        protocol: tcp
        mode: host
      - target: 25
        published: "2525"
        host_ip: 127.0.0.1
        protocol: udp
      - target: 3000
    volumes:
      - type: volume
        source: mail-certs
        target: /certs
        read_only: true
      - type: bind
        source: ../files/pouch.yml
        target: /app/pouch.yml
        read_only: true
        bind:
          create_host_path: true
      - type: volume
        source: data
        target: /data
        volume:
          nocopy: true
      - type: volume
        target: /scratch
      - type: tmpfs
        target: /run/cache
      - mail-pg:/var/lib/postgresql/data
volumes:
  mail-certs:
  data:
  mail-pg:
`;

describe("long-syntax volumes and ports", () => {
  const svc = parseCompose(SOURCE).services["mail-smtp"];

  it("converts ports to the short form", () => {
    expect(svc.ports).toEqual(["587:587", "127.0.0.1:2525:25/udp", "3000"]);
  });

  it("converts volumes to the short form", () => {
    expect(svc.volumes).toEqual([
      "mail-certs:/certs:ro",
      "../files/pouch.yml:/app/pouch.yml:ro",
      "data:/data:nocopy",
      "/scratch",
      "mail-pg:/var/lib/postgresql/data",
    ]);
  });

  it("moves tmpfs mounts to tmpfs", () => {
    expect(svc.tmpfs).toEqual(["/run/cache"]);
  });

  it("never produces [object Object]", () => {
    expect(composeToYaml(parseCompose(SOURCE))).not.toContain("[object Object]");
  });

  it("rejects mounts the short form can't express", () => {
    const bad = `services:
  a:
    image: x
    volumes:
      - type: volume
        source: v
        target: /d
        volume:
          subpath: sub
`;
    expect(() => parseCompose(bad)).toThrow(/subpath/);
  });
});
