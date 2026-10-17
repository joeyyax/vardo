import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { servingDeployVars, type ServingLoader } from "@/lib/docker/serving-deploy-vars";

type Row = Awaited<ReturnType<ServingLoader["byId"]>>;

const vars = (id: string, sha: string) => ({
  web: { VARDO_APP_NAME: "shop", VARDO_DEPLOY_ID: id, VARDO_GIT_SHA: sha },
  api: { VARDO_APP_NAME: "shop-api", VARDO_DEPLOY_ID: id, VARDO_GIT_SHA: sha },
});

function loader(rows: Record<string, NonNullable<Row>>, latest: string | null, app: Partial<Awaited<ReturnType<ServingLoader["app"]>>> = {}): ServingLoader {
  return {
    app: async (id) => ({ id, name: "shop", parentAppId: null, composeService: null, ...app }),
    environment: async () => ({ id: "env-prod", isDefault: true }),
    latest: async () => (latest ? rows[latest] : null),
    byId: async (id) => rows[id] ?? null,
  };
}

const deploy = (id: string, sha: string): NonNullable<Row> => ({ id, rollbackFromId: null, configSnapshot: { deployVars: vars(id, sha) } as never });

describe("servingDeployVars", () => {
  it("reads the app's own service from the latest deploy", async () => {
    const rows = { "dep-2": deploy("dep-2", "bbb") };
    expect(await servingDeployVars("app", null, loader(rows, "dep-2"))).toEqual({ deploymentId: "dep-2", vars: vars("dep-2", "bbb").web });
  });

  it("after an instant rollback, shows the deploy that built the restored slot", async () => {
    const rows = {
      "dep-1": deploy("dep-1", "aaa"),
      "dep-2": deploy("dep-2", "bbb"),
      "rb-1": { id: "rb-1", rollbackFromId: "dep-1", configSnapshot: null },
    };
    const serving = await servingDeployVars("app", null, loader(rows, "rb-1"));
    expect(serving?.vars.VARDO_GIT_SHA).toBe("aaa");
    expect(serving?.vars.VARDO_DEPLOY_ID).toBe("dep-1");
  });

  it("gives a child app its own service", async () => {
    const rows = { "dep-2": deploy("dep-2", "bbb") };
    const serving = await servingDeployVars("child", null, loader(rows, "dep-2", { name: "shop-api", parentAppId: "app", composeService: "api" }));
    expect(serving?.vars.VARDO_APP_NAME).toBe("shop-api");
  });

  it("is null before a deploy that recorded them", async () => {
    const rows = { "dep-0": { id: "dep-0", rollbackFromId: null, configSnapshot: {} as never } };
    expect(await servingDeployVars("app", null, loader(rows, "dep-0"))).toBeNull();
    expect(await servingDeployVars("app", null, loader({}, null))).toBeNull();
  });
});
