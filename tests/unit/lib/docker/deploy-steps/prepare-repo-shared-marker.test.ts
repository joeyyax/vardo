import { describe, it, expect } from "vitest";
import { sharedMarkerTypeErrors } from "@/lib/docker/compose";
import { SHARED_MARKER } from "@/lib/docker/slot-partition";

/**
 * The deploy path is the only one a git-sourced compose reaches — it never
 * passes through a save route. `parseAndSanitize` runs these before
 * `parseCompose`, which drops a non-boolean marker without a trace.
 */
describe("deploy blocks a mistyped x-vardo-shared", () => {
  const compose = (markerValue: string) =>
    [
      "services:",
      "  db:",
      "    image: postgres:17",
      `    ${SHARED_MARKER}: ${markerValue}`,
      "  web:",
      "    image: nginx",
    ].join("\n");

  it("rejects a quoted marker", () => {
    const errors = sharedMarkerTypeErrors(compose('"true"'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("db");
    expect(errors[0]).toContain(SHARED_MARKER);
  });

  it("rejects the YAML 1.1 boolean spellings the 1.2 core schema reads as strings", () => {
    for (const value of ["yes", "on", "y", "Yes", "ON"]) {
      expect(sharedMarkerTypeErrors(compose(value))).toHaveLength(1);
    }
  });

  it("accepts real booleans", () => {
    expect(sharedMarkerTypeErrors(compose("true"))).toEqual([]);
    expect(sharedMarkerTypeErrors(compose("false"))).toEqual([]);
  });

  it("ignores compose with no marker at all", () => {
    expect(sharedMarkerTypeErrors("services:\n  web:\n    image: nginx\n")).toEqual([]);
  });

  it("returns nothing for unparseable YAML, leaving the parser to report it", () => {
    expect(sharedMarkerTypeErrors("services: [unclosed")).toEqual([]);
  });
});
