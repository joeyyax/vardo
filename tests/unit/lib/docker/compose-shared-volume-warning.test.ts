import { describe, expect, it } from "vitest";
import { parseCompose } from "@/lib/docker/compose-parse";
import { unmarkedSharedVolumeWarnings } from "@/lib/docker/compose-validate";

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

describe("unmarkedSharedVolumeWarnings", () => {
  it("names the service, its image and the volume both slots would address", () => {
    const [warning, ...rest] = unmarkedSharedVolumeWarnings(parseCompose(UNMARKED));
    expect(rest).toEqual([]);
    expect(warning).toContain(`Service "postgres"`);
    expect(warning).toContain("postgres:17");
    expect(warning).toContain(`"postgres-data"`);
    expect(warning).toContain("x-vardo-shared: true");
  });

  it("says nothing once the marker is there", () => {
    const marked = UNMARKED.replace("image: postgres:17", "image: postgres:17\n    x-vardo-shared: true");
    expect(unmarkedSharedVolumeWarnings(parseCompose(marked))).toEqual([]);
  });

  it("says nothing about a stateless service holding a named volume", () => {
    const stateless = parseCompose(`services:
  web:
    image: app
    volumes:
      - uploads:/data
  sidecar:
    image: nginx
volumes:
  uploads: {}
`);
    expect(unmarkedSharedVolumeWarnings(stateless)).toEqual([]);
  });

  it("says the rotation stands when detection could not take the service out of it", () => {
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
    const [warning] = unmarkedSharedVolumeWarnings(dependent);
    expect(warning).toContain("two copies will hold it during a deploy");
  });

  it("names the host path a bind-mounted database keeps its data on", () => {
    const bind = parseCompose(`services:
  web:
    image: app
  postgres:
    image: postgres:17
    volumes:
      - /mnt/docker/app/postgres:/var/lib/postgresql/data
`);
    const [warning, ...rest] = unmarkedSharedVolumeWarnings(bind);
    expect(rest).toEqual([]);
    expect(warning).toContain("/mnt/docker/app/postgres:/var/lib/postgresql/data");
    expect(warning).toContain("x-vardo-shared: true");
  });

  it("says nothing about a bind mount that is not a data directory", () => {
    const config = parseCompose(`services:
  web:
    image: app
  postgres:
    image: postgres:17
    volumes:
      - /etc/localtime:/etc/localtime
`);
    expect(unmarkedSharedVolumeWarnings(config)).toEqual([]);
  });
});
