import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { olderThan, selectUnusedImages, staleOneOffs, type ImageRow } from "@/lib/docker/host-reclaim/policy";
import { buildProtection, retainedDeployments, type DeploymentRow } from "@/lib/docker/host-reclaim/protect";
import { dueTrigger, DEPLOY_SETTLE_MS, NIGHTLY_MS } from "@/lib/docker/host-reclaim/scheduler";
import { deploymentImageName } from "@/lib/docker/image-tag";

const HOUR = 3_600_000;
const now = 1_000 * HOUR;

function image(id: string, tags: string[], extra: Partial<ImageRow> = {}): ImageRow {
  return { id, repoTags: tags, size: 100, labels: {}, ...extra };
}

/** Newest first, as loadProtection orders them. */
function history(appId: string, appName: string, ids: string[], config: DeploymentRow["config"] = null): DeploymentRow[] {
  return ids.map((id) => ({ id, appId, appName, config }));
}

const ids = (sel: { candidates: { id: string }[] }) => sel.candidates.map((c) => c.id).sort();

describe("rollback targets", () => {
  it("keeps the built images of the retained successful deployments and takes older ones", () => {
    const deployments = history("a1", "shop", ["dep-new1", "dep-prev", "dep-old2", "dep-old3"]);
    const p = buildProtection([{ name: "shop", imageName: null, composeContent: null }], deployments);
    const images = deployments.map((d) => image(d.id, [deploymentImageName("shop", d.id)]));

    const sel = selectUnusedImages(images, [], p);

    expect(ids(sel)).toEqual(["dep-old3"]);
    expect(sel.kept.referenced).toBe(3);
  });

  it("keeps a pulled rollback target by digest and by tag", () => {
    const p = buildProtection(
      [{ name: "api", imageName: "ghcr.io/acme/api:2.1.0", composeContent: null }],
      history("a1", "api", ["d2", "d1"], { imageName: "ghcr.io/acme/api:2.0.0", imageDigest: "ghcr.io/acme/api@sha256:aaa" }),
    );
    const sel = selectUnusedImages(
      [
        image("current", ["ghcr.io/acme/api:2.1.0"]),
        image("by-tag", ["ghcr.io/acme/api:2.0.0"]),
        image("by-digest", ["ghcr.io/acme/api:1.9.0"], { repoDigests: ["ghcr.io/acme/api@sha256:aaa"] }),
        image("stale", ["ghcr.io/acme/api:1.0.0"]),
      ],
      [],
      p,
    );
    expect(ids(sel)).toEqual(["stale"]);
  });

  it("counts deployments per app", () => {
    const rows = [...history("a", "a", ["a1", "a2", "a3", "a4"]), ...history("b", "b", ["b1"])];
    expect(retainedDeployments(rows).map((r) => r.id)).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("keeps every tag of a repository a compose file names through a variable", () => {
    const p = buildProtection(
      [{ name: "web", imageName: null, composeContent: "services:\n  web:\n    image: ghcr.io/acme/web:${TAG}\n" }],
      [],
    );
    const sel = selectUnusedImages([image("v1", ["ghcr.io/acme/web:1.0"]), image("x", ["ghcr.io/acme/other:1.0"])], [], p);
    expect(ids(sel)).toEqual(["x"]);
  });
});

describe("images containers use", () => {
  const p = buildProtection([], []);

  it("keeps an image a running container uses", () => {
    const sel = selectUnusedImages([image("sha256:run", ["redis:7.2"])], [{ image: "redis:7.2", imageId: "sha256:run" }], p);
    expect(sel.candidates).toEqual([]);
    expect(sel.kept["in-use"]).toBe(1);
  });

  it("keeps an image only a stopped standby slot's container uses", () => {
    // listAllContainers returns stopped containers too; the idle slot is one of them.
    const sel = selectUnusedImages([image("sha256:idle", ["host/shop:abc12345"])], [{ image: "sha256:idle", imageId: "sha256:idle" }], p);
    expect(sel.candidates).toEqual([]);
  });

  it("leaves compose-built slot images to the slot sweep", () => {
    const sel = selectUnusedImages([image("s", ["shop-production-blue-web"], { labels: { "com.docker.compose.project": "shop-production-blue" } })], [], p);
    expect(sel.kept["compose-build"]).toBe(1);
  });

  it("keeps helper and Vardo images", () => {
    const sel = selectUnusedImages([image("a", ["alpine:3.20"]), image("v", ["ghcr.io/joeyyax/vardo:main"])], [], p);
    expect(sel.candidates).toEqual([]);
  });

  it("takes an image nothing uses or names", () => {
    const sel = selectUnusedImages([image("old", ["nginx:1.25.0"]), image("dangling", ["<none>:<none>"])], [], p);
    expect(ids(sel)).toEqual(["old"]);
    expect(sel.kept.untagged).toBe(1);
  });
});

describe("olderThan", () => {
  it("keeps recent and unreadable images", () => {
    const sel = { candidates: [image("old", ["a:1"]), image("new", ["b:1"]), image("unknown", ["c:1"])].map((i) => ({ id: i.id, tags: i.repoTags, size: 1 })), kept: selectUnusedImages([], [], buildProtection([], [])).kept };
    const aged = olderThan(sel, new Map([["old", now - 72 * HOUR], ["new", now - HOUR], ["unknown", null]]), now, 48 * HOUR);
    expect(ids(aged)).toEqual(["old"]);
    expect(aged.kept).toMatchObject({ recent: 1, "age-unknown": 1 });
  });
});

describe("staleOneOffs", () => {
  it("takes only exited compose run containers", () => {
    const old = (now - 2 * HOUR) / 1000;
    const found = staleOneOffs(
      [
        { id: "run", state: "exited", labels: { "com.docker.compose.oneoff": "True" }, created: old },
        { id: "running", state: "running", labels: { "com.docker.compose.oneoff": "True" }, created: old },
        { id: "standby", state: "exited", labels: { "com.docker.compose.oneoff": "False" }, created: old },
        { id: "fresh", state: "exited", labels: { "com.docker.compose.oneoff": "True" }, created: now / 1000 },
      ],
      now,
      HOUR,
    );
    expect(found).toEqual(["run"]);
  });
});

describe("dueTrigger", () => {
  it("waits for deploys to settle, then runs once", () => {
    expect(dueTrigger({ now, lastRunAt: now - HOUR, lastDeployAt: now - 60_000 })).toBeNull();
    expect(dueTrigger({ now, lastRunAt: now - HOUR, lastDeployAt: now - DEPLOY_SETTLE_MS })).toBe("deploy");
    expect(dueTrigger({ now, lastRunAt: now - 1000, lastDeployAt: now - DEPLOY_SETTLE_MS })).toBeNull();
  });

  it("runs nightly without deploys", () => {
    expect(dueTrigger({ now, lastRunAt: now - NIGHTLY_MS, lastDeployAt: null })).toBe("nightly");
    expect(dueTrigger({ now, lastRunAt: null, lastDeployAt: null })).toBe("nightly");
    expect(dueTrigger({ now, lastRunAt: now - HOUR, lastDeployAt: null })).toBeNull();
  });
});
