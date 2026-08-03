import { describe, it, expect } from "vitest";
import {
  isVardoStack,
  systemManagedRefusal,
  type SystemManagedAction,
} from "@/lib/api/system-managed";

const DEFINITION: SystemManagedAction[] = ["edit", "delete", "env-vars", "domains"];
const LIFECYCLE: SystemManagedAction[] = [
  "deploy",
  "rollback",
  "restart",
  "recreate",
  "stop",
];

const vardo = { isSystemManaged: true, name: "vardo" };
const vardoChild = { isSystemManaged: true, name: "vardo-postgres" };
// Decomposition created child rows without the parent's flag; migration 0050
// backfills them, but the guard must not depend on that having run.
const unflaggedVardoChild = { isSystemManaged: false, name: "vardo-frontend" };
const infra = { isSystemManaged: true, name: "cadvisor" };
const userApp = { isSystemManaged: false, name: "my-app" };

describe("systemManagedRefusal", () => {
  it("allows every action on apps that are not system-managed", () => {
    for (const action of [...DEFINITION, ...LIFECYCLE]) {
      expect(systemManagedRefusal(userApp, action)).toBeNull();
    }
  });

  it("refuses every definition verb on a system-managed app", () => {
    for (const action of DEFINITION) {
      expect(systemManagedRefusal(vardo, action)).toBeTruthy();
      expect(systemManagedRefusal(infra, action)).toBeTruthy();
    }
  });

  it("allows every lifecycle verb on an infra app", () => {
    for (const action of LIFECYCLE) {
      expect(systemManagedRefusal(infra, action)).toBeNull();
    }
  });

  it("allows deploy on Vardo's own stack and every verb that undoes it", () => {
    for (const action of ["deploy", "rollback", "restart", "recreate"] as const) {
      expect(systemManagedRefusal(vardo, action)).toBeNull();
    }
  });

  it("refuses stop on Vardo's own stack and its compose children", () => {
    expect(systemManagedRefusal(vardo, "stop")).toMatch(/take down the API/);
    expect(systemManagedRefusal(vardoChild, "stop")).toMatch(/take down the API/);
  });

  it("refuses stop on a Vardo child whose own system-managed flag is false", () => {
    expect(systemManagedRefusal(unflaggedVardoChild, "stop")).toMatch(/take down the API/);
  });

  it("still allows stop on an app that only looks like a Vardo child", () => {
    expect(systemManagedRefusal({ isSystemManaged: false, name: "vardose" }, "stop")).toBeNull();
  });

  it("explains that Vardo rewrites the record rather than just refusing", () => {
    expect(systemManagedRefusal(vardo, "edit")).toMatch(/rewrites the record/);
    expect(systemManagedRefusal(vardo, "delete")).toMatch(/recreates it/);
  });

  it("treats a null isSystemManaged column as not system-managed", () => {
    expect(systemManagedRefusal({ isSystemManaged: null, name: "vardo" }, "delete")).toBeNull();
  });
});

describe("isVardoStack", () => {
  it("matches the self app and its compose children", () => {
    expect(isVardoStack("vardo")).toBe(true);
    expect(isVardoStack("vardo-traefik")).toBe(true);
  });

  it("does not match infra apps or lookalike names", () => {
    expect(isVardoStack("cadvisor")).toBe(false);
    expect(isVardoStack("vardose")).toBe(false);
    expect(isVardoStack(null)).toBe(false);
  });
});
