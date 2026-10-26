import { describe, it, expect } from "vitest";

import { redirectReplacement } from "@/lib/domains/redirect-target";

describe("redirectReplacement", () => {
  it("appends the captured request path", () => {
    expect(redirectReplacement("https://new.test")).toBe("https://new.test${1}");
  });

  it("drops a trailing slash so the path isn't doubled", () => {
    expect(redirectReplacement("https://new.test/")).toBe("https://new.test${1}");
    expect(redirectReplacement("https://new.test/blog/")).toBe("https://new.test/blog${1}");
  });

  it("escapes every $ in the target, including ones that look like capture groups", () => {
    expect(redirectReplacement("https://new.test/?a=$1&b=${1}&c=$x")).toBe("https://new.test/?a=$$1&b=$${1}&c=$$x${1}");
  });
});
