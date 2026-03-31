import { describe, it, expect } from "vitest";
import { checkExposedPorts } from "@/lib/security/ports";

describe("checkExposedPorts", () => {
  it("returns no findings for empty port list", () => {
    expect(checkExposedPorts([])).toEqual([]);
  });

  it("returns no findings for non-sensitive ports", () => {
    expect(checkExposedPorts([{ internal: 3000 }, { internal: 8080 }])).toEqual([]);
  });

  it("flags PostgreSQL port as critical", () => {
    const findings = checkExposedPorts([{ internal: 5432 }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].type).toBe("exposed-port");
  });

  it("flags Redis port as critical", () => {
    const findings = checkExposedPorts([{ internal: 6379 }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("flags Docker daemon port as critical", () => {
    const findings = checkExposedPorts([{ internal: 2375 }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("flags SSH port as warning", () => {
    const findings = checkExposedPorts([{ internal: 22 }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
  });

  it("deduplicates findings when multiple ports share a rule", () => {
    // 5432 and 5433 both match PostgreSQL rule
    const findings = checkExposedPorts([{ internal: 5432 }, { internal: 5433 }]);
    expect(findings).toHaveLength(1);
  });

  it("returns findings for multiple distinct sensitive ports", () => {
    const findings = checkExposedPorts([
      { internal: 5432 },
      { internal: 3306 },
      { internal: 6379 },
    ]);
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.severity === "critical")).toBe(true);
  });

  it("includes the port number as detail", () => {
    const findings = checkExposedPorts([{ internal: 5432 }]);
    expect(findings[0].detail).toBe("5432");
  });
});
