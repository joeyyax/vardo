import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { ENV_MASK, MaskedComposeError, maskComposeEnv, unmaskComposeEnv } from "@/lib/docker/compose-mask";

const COMPOSE = `# stack
x-common: &common
  SHARED_TOKEN: shared-secret-value
services:
  web:
    image: nginx
    environment:
      DB_PASSWORD: hunter2-secret
      PORT: 8080
      API_KEY: \${API_KEY}
      URL: postgres://u:\${DB_PASSWORD}@db/app
      EMPTY:
      <<: *common
  worker:
    image: worker
    environment:
      - SECRET=list-secret-value
      - REF=\${OTHER}
      - PASSTHROUGH
`;

describe("maskComposeEnv", () => {
  const masked = maskComposeEnv(COMPOSE);
  const doc = parse(masked);

  it("masks map and list values and keeps keys", () => {
    expect(doc.services.web.environment.DB_PASSWORD).toBe(ENV_MASK);
    expect(doc.services.web.environment.PORT).toBe(ENV_MASK);
    expect(doc.services.worker.environment).toContain(`SECRET=${ENV_MASK}`);
    expect(masked).not.toContain("hunter2-secret");
    expect(masked).not.toContain("list-secret-value");
  });

  it("masks values reached through a merge key", () => {
    expect(masked).not.toContain("shared-secret-value");
    expect(doc["x-common"].SHARED_TOKEN).toBe(ENV_MASK);
  });

  it("keeps pure references, empty values and the rest of the file", () => {
    expect(doc.services.web.environment.API_KEY).toBe("${API_KEY}");
    expect(doc.services.worker.environment).toContain("REF=${OTHER}");
    expect(doc.services.worker.environment).toContain("PASSTHROUGH");
    expect(doc.services.web.environment.EMPTY).toBeNull();
    expect(doc.services.web.image).toBe("nginx");
    expect(masked).toContain("# stack");
  });

  it("masks a value that mixes a reference with literal text", () => {
    expect(doc.services.web.environment.URL).toBe(ENV_MASK);
  });

  it("masks an environment given as an alias", () => {
    const out = maskComposeEnv(
      "x-env: &env\n  TOKEN: aliased-secret\nservices:\n  web:\n    environment: *env\n",
    );
    expect(out).not.toContain("aliased-secret");
  });

  it("falls back to pattern redaction for invalid YAML", () => {
    const out = maskComposeEnv("services: [\n  DB_PASSWORD=hunter2-secret");
    expect(out).not.toContain("hunter2-secret");
  });

  it("leaves compose without environment untouched", () => {
    const plain = "services:\n  web:\n    image: nginx # pinned\n";
    expect(maskComposeEnv(plain)).toBe(plain);
  });
});

describe("unmaskComposeEnv", () => {
  it("restores saved values where the mask was kept", () => {
    const edited = maskComposeEnv(COMPOSE).replace("image: nginx", "image: nginx:1.27");
    const out = parse(unmaskComposeEnv(edited, COMPOSE));
    expect(out.services.web.image).toBe("nginx:1.27");
    expect(out.services.web.environment.DB_PASSWORD).toBe("hunter2-secret");
    expect(out.services.web.environment.PORT).toBe(8080);
    expect(out.services.worker.environment).toContain("SECRET=list-secret-value");
    expect(out["x-common"].SHARED_TOKEN).toBe("shared-secret-value");
  });

  it("keeps values the caller changed", () => {
    const edited = maskComposeEnv(COMPOSE).replace(/DB_PASSWORD: "?\*+"?/, "DB_PASSWORD: new-value");
    const out = parse(unmaskComposeEnv(edited, COMPOSE));
    expect(out.services.web.environment.DB_PASSWORD).toBe("new-value");
  });

  it("refuses a mask with no saved value", () => {
    const edited = `services:\n  api:\n    environment:\n      TOKEN: "${ENV_MASK}"\n`;
    expect(() => unmaskComposeEnv(edited, COMPOSE)).toThrow(MaskedComposeError);
  });

  it("returns input without a mask unchanged", () => {
    expect(unmaskComposeEnv(COMPOSE, null)).toBe(COMPOSE);
  });
});
