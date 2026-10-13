import { describe, expect, it } from "vitest";
import { DEFAULT_APP_PROBE_GUARD } from "@/lib/probe-guard/settings";
import { answerSuggestion, detectWordPress, pendingSuggestion } from "@/lib/probe-guard/suggestions";

describe("detectWordPress", () => {
  it("reads the image, template and compose file", () => {
    expect(detectWordPress({ imageName: "wordpress:6-php8.3" })).toBe(true);
    expect(detectWordPress({ imageName: "bitnami/wordpress" })).toBe(true);
    expect(detectWordPress({ templateName: "wordpress" })).toBe(true);
    expect(detectWordPress({ composeContent: "services:\n  wp:\n    image: wordpress:latest\n" })).toBe(true);
    expect(detectWordPress({ childImages: [null, "docker.io/library/wordpress@sha256:abc"] })).toBe(true);
  });

  it("ignores lookalikes", () => {
    expect(detectWordPress({ imageName: "ghost:5" })).toBe(false);
    expect(detectWordPress({ imageName: "acme/wordpress-exporter" })).toBe(false);
    expect(detectWordPress({ composeContent: "# migrated from wordpress\nservices:\n  web:\n    image: nginx\n" })).toBe(false);
  });
});

describe("pendingSuggestion", () => {
  it("asks an app that doesn't look like WordPress", () => {
    expect(pendingSuggestion(DEFAULT_APP_PROBE_GUARD, false)?.ruleIds).toEqual(["wp-login", "wp-admin", "xmlrpc", "wp-config"]);
  });

  it("stays quiet for WordPress, a disabled guard and an answered question", () => {
    expect(pendingSuggestion(DEFAULT_APP_PROBE_GUARD, true)).toBeNull();
    expect(pendingSuggestion({ ...DEFAULT_APP_PROBE_GUARD, enabled: false }, false)).toBeNull();
    const asked = pendingSuggestion(DEFAULT_APP_PROBE_GUARD, false)!;
    expect(pendingSuggestion(answerSuggestion(DEFAULT_APP_PROBE_GUARD, asked, false), false)).toBeNull();
  });

  it("switches the rules on for Block them and records Keep off as false", () => {
    const asked = pendingSuggestion(DEFAULT_APP_PROBE_GUARD, false)!;
    expect(answerSuggestion(DEFAULT_APP_PROBE_GUARD, asked, true).rules).toEqual({ "wp-login": true, "wp-admin": true, xmlrpc: true, "wp-config": true });
    expect(answerSuggestion(DEFAULT_APP_PROBE_GUARD, asked, false).rules["wp-login"]).toBe(false);
  });
});
