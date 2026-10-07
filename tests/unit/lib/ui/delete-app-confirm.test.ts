import { describe, it, expect } from "vitest";
import { deleteConfirmState } from "@/lib/ui/delete-app-confirm";

const base = {
  preview: "ready" as const,
  hasData: true,
  deleteVolumes: false,
  typed: "",
  appName: "api",
  noun: "app" as const,
};

describe("deleteConfirmState", () => {
  it("blocks confirm while the volume check runs", () => {
    expect(deleteConfirmState({ ...base, preview: "loading" }).disabled).toBe(true);
  });

  it("allows a keep-volumes delete once the check fails", () => {
    const state = deleteConfirmState({ ...base, preview: "failed", deleteVolumes: true });
    expect(state).toEqual({ disabled: false, label: "Delete app", deleteVolumes: false });
  });

  it("asks for the name before destroying volumes", () => {
    expect(deleteConfirmState({ ...base, deleteVolumes: true }).disabled).toBe(true);
    expect(deleteConfirmState({ ...base, deleteVolumes: true, typed: "api" })).toEqual({
      disabled: false,
      label: "Delete app and volumes",
      deleteVolumes: true,
    });
  });

  it("uses the trigger's noun", () => {
    expect(deleteConfirmState({ ...base, noun: "stack" }).label).toBe("Delete stack");
    expect(
      deleteConfirmState({ ...base, noun: "stack", deleteVolumes: true, typed: "api" }).label,
    ).toBe("Delete stack and volumes");
  });
});
