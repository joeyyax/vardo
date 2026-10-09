import { describe, expect, it } from "vitest";
import { render } from "react-email";
import { DiskWriteAlertEmail } from "@/lib/email/templates/disk-write-alert";

const base = {
  appName: "MySQL",
  projectName: "Shop Staging",
  composeService: "mysql",
  containerName: "shop-staging-data-production-blue-shop-staging-mysql-1",
  writeAmount: "7.7 GiB",
  threshold: "1 GiB",
  dashboardUrl: "https://host.example.com/apps/x",
};

describe("DiskWriteAlertEmail", () => {
  it("shows the app and stack as the heading and the container once", async () => {
    const html = await render(DiskWriteAlertEmail(base));
    expect(html).toContain("MySQL");
    expect(html).toContain("Shop Staging / mysql");
    expect(html.split(base.containerName).length - 1).toBe(1);
    expect(html).toContain("7.7 GiB");
  });

  it("explains database writes differently from file writes", async () => {
    const db = await render(DiskWriteAlertEmail({ ...base, dataEngine: true }));
    expect(db).toContain("bulk load");
    expect(db).not.toContain("S3/R2");
    const app = await render(DiskWriteAlertEmail(base));
    expect(app).toContain("S3/R2");
  });
});
