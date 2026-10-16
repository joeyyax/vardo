import { describe, expect, it } from "vitest";
import {
  detectBackupTarget,
  detectCloudflare,
  detectEmail,
  detectHostingProvider,
  reconcile,
  subprocessorReviews,
  type Detected,
  type SubprocessorRow,
} from "@/lib/trust/subprocessors";

const row = (over: Partial<SubprocessorRow>): SubprocessorRow => ({
  id: "row-1",
  key: "backup:r2",
  name: "Cloudflare R2",
  purpose: "Encrypted backups",
  region: null,
  status: "suggested",
  detected: true,
  ...over,
});
const r2: Detected = { key: "backup:r2", name: "Cloudflare R2", purpose: "Encrypted backups", region: null };

describe("reconcile", () => {
  it("suggests a new detection and never confirms it", () => {
    const plan = reconcile([], [r2]);
    expect(plan.insert).toEqual([r2]);
  });

  it("leaves a confirmed row's text alone when detection changes the details", () => {
    const plan = reconcile([row({ status: "confirmed", name: "My R2 bucket" })], [r2]);
    expect(plan).toEqual({ insert: [], refresh: [], back: [], gone: [], drop: [] });
  });

  it("refreshes a suggestion that is still unconfirmed", () => {
    const plan = reconcile([row({ region: null })], [{ ...r2, region: "EU" }]);
    expect(plan.refresh).toEqual([{ id: "row-1", name: "Cloudflare R2", purpose: "Encrypted backups", region: "EU" }]);
  });

  it("keeps a confirmed row listed when it disappears, and marks it gone for review", () => {
    const plan = reconcile([row({ status: "confirmed" })], []);
    expect(plan.gone).toEqual(["row-1"]);
    expect(plan.drop).toEqual([]);
  });

  it("doesn't mark a gone row twice, and brings it back when detected again", () => {
    expect(reconcile([row({ status: "confirmed", detected: false })], []).gone).toEqual([]);
    expect(reconcile([row({ status: "confirmed", detected: false })], [r2]).back).toEqual(["row-1"]);
  });

  it("drops suggestions and dismissals that disappear", () => {
    expect(reconcile([row({ status: "suggested" }), row({ id: "row-2", key: "x", status: "dismissed" })], []).drop).toEqual(["row-1", "row-2"]);
  });

  it("doesn't suggest a dismissed detection again", () => {
    expect(reconcile([row({ status: "dismissed" })], [r2]).insert).toEqual([]);
  });

  it("never touches a subprocessor the operator added", () => {
    const plan = reconcile([row({ key: null, status: "confirmed", detected: false })], []);
    expect(plan).toEqual({ insert: [], refresh: [], back: [], gone: [], drop: [] });
  });
});

describe("subprocessorReviews", () => {
  it("asks about new suggestions and about confirmed rows that are gone", () => {
    const reviews = subprocessorReviews([
      row({ id: "a", status: "suggested", name: "New Co" }),
      row({ id: "b", key: "k", status: "confirmed", detected: false, name: "Old Co" }),
      row({ id: "c", key: "k2", status: "confirmed", name: "Fine Co" }),
      row({ id: "d", key: "k3", status: "dismissed", name: "Dismissed Co" }),
    ]);
    expect(reviews.map((r) => r.title)).toEqual(["Review New Co as a subprocessor", "Old Co is no longer detected"]);
  });
});

describe("detectors", () => {
  it("names backup destinations and skips ones on the host", () => {
    expect(detectBackupTarget({ type: "r2", config: {} })?.name).toBe("Cloudflare R2");
    expect(detectBackupTarget({ type: "b2", config: { region: "us-west-004" } })).toMatchObject({ name: "Backblaze B2", region: "us-west-004" });
    expect(detectBackupTarget({ type: "s3", config: { region: "eu-west-1" } })).toMatchObject({ key: "backup:s3", name: "Amazon S3" });
    expect(detectBackupTarget({ type: "s3", config: { endpoint: "https://s3.eu-central-1.wasabisys.com" } })?.name).toBe("Wasabi");
    expect(detectBackupTarget({ type: "s3", config: { endpoint: "https://minio.acme.example:9000" } })).toMatchObject({ key: "backup:s3:minio.acme.example", name: "minio.acme.example" });
    expect(detectBackupTarget({ type: "ssh", config: { host: "localhost" } })).toBeNull();
    expect(detectBackupTarget({ type: "ssh", config: { host: "Box.Acme.Example" } })?.name).toBe("box.acme.example");
    expect(detectBackupTarget({ type: "local", config: { path: "/data" } })).toBeNull();
  });

  it("names the email provider", () => {
    expect(detectEmail({ provider: "pouch" })).toMatchObject({ key: "email:pouch", name: "Pouch" });
    expect(detectEmail({ provider: "smtp", smtpHost: "smtp.mailer.example" })?.name).toBe("smtp.mailer.example");
    expect(detectEmail({ provider: "smtp" })).toBeNull();
    expect(detectEmail(null)).toBeNull();
  });

  it("suggests the hosting provider and Cloudflare only when it fronts the domains", () => {
    expect(detectHostingProvider({ provider: "Hetzner Online", region: "Nuremberg, Germany" })).toMatchObject({ key: "hosting:hetzner-online", region: "Nuremberg, Germany" });
    expect(detectHostingProvider(null)).toBeNull();
    expect(detectCloudflare(true)?.name).toBe("Cloudflare");
    expect(detectCloudflare(false)).toBeNull();
  });
});
