import { describe, it, expect } from "vitest";
import { defaultNote, majorEntries, opensByDefault, stayLabel } from "@/components/image-updates/major-versions";
import { trackMessage } from "@/components/image-updates/track-request";
import { GLOSSARY, termForText } from "@/lib/ui/glossary";
import type { ServiceUpdateStatus } from "@/lib/docker/image-updates/status";

function service(overrides: Partial<ServiceUpdateStatus>): ServiceUpdateStatus {
  return {
    service: "db",
    image: "postgres:16",
    currentTag: "16",
    status: "current",
    latestTag: null,
    severity: null,
    unorderable: [],
    available: [],
    majorAvailable: "18",
    majorTags: ["18", "17"],
    track: { mode: "major", explicit: false, defaultMode: "major", reason: "stores data in /var/lib/postgresql/data", major: 16 },
    majorHeld: true,
    reasons: [],
    majorLocked: true,
    error: null,
    checkedAt: null,
    stale: false,
    ...overrides,
  };
}

const eol = {
  kind: "eol" as const,
  notice: { engine: "postgres", label: "PostgreSQL", series: "14", eol: "2026-11-12", source: "", state: "ending" as const, daysLeft: 30 },
};

describe("majorEntries", () => {
  it("keeps services with a major or a reason, offered first, once each", () => {
    const entries = majorEntries([
      { appId: "a", service: service({ service: "db" }) },
      { appId: "a", service: service({ service: "web", image: "ghost:5", majorHeld: false }) },
      { appId: "a", service: service({ service: "web", image: "ghost:5", majorHeld: false }) },
      { appId: "a", service: service({ service: "cache", majorAvailable: null, majorTags: [] }) },
      { appId: "a", service: service({ service: "old", majorAvailable: null, majorHeld: false, reasons: [eol] }) },
    ]);
    expect(entries.map((e) => e.key)).toEqual(["a:web", "a:old", "a:db"]);
  });
});

describe("opensByDefault", () => {
  it("stays collapsed unless a major needs a decision", () => {
    expect(opensByDefault(majorEntries([{ appId: "a", service: service({}) }]))).toBe(false);
    expect(opensByDefault(majorEntries([{ appId: "a", service: service({ reasons: [eol] }) }]))).toBe(true);
  });
});

describe("copy", () => {
  it("names the running major", () => {
    expect(stayLabel(service({}))).toBe("Stay on 16");
    expect(stayLabel(service({ track: { mode: "major", explicit: false, defaultMode: "major", reason: null, major: null } }))).toBe("Stay on this major");
    expect(trackMessage("db", "major", 16)).toBe("db stays on 16. Patch and minor updates keep coming.");
    expect(trackMessage("db", "latest", 16)).toBe("db follows the latest major.");
  });

  it("explains the terms the section uses", () => {
    expect(GLOSSARY["major-version"].term).toBe("Major version");
    expect(GLOSSARY["stay-on-major"].term).toBe("Stay on major");
    expect(termForText("New major versions")).toBe("major-version");
    expect(termForText("End of life")).toBe("end-of-life");
  });
});

describe("defaultNote", () => {
  it("explains a default stay and stays quiet once someone chose", () => {
    expect(defaultNote(service({}))).toBe("Stays on 16 by default: stores data in /var/lib/postgresql/data.");
    expect(
      defaultNote(service({ track: { mode: "major", explicit: true, defaultMode: "major", reason: "x", major: 16 } })),
    ).toBeNull();
    expect(
      defaultNote(service({ track: { mode: "latest", explicit: false, defaultMode: "latest", reason: null, major: 16 } })),
    ).toBeNull();
  });
});
