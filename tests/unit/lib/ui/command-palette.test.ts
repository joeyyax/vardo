import { describe, it, expect } from "vitest";
import {
  byRelevance,
  fillApp,
  rankActions,
  rankResult,
  ID_SEP,
  COMMAND_ACTIONS,
} from "@/lib/ui/command-palette";

describe("rankResult", () => {
  it("ranks an exact name above every keyword match", () => {
    const exact = rankResult(`Plex${ID_SEP}1`, "plex");
    const keyword = rankResult(`Sonarr${ID_SEP}2`, "plex", ["plex"]);
    expect(exact).toBeGreaterThan(keyword);
  });

  it("orders name matches: exact, prefix, substring", () => {
    expect(rankResult(`Plex${ID_SEP}1`, "plex")).toBe(1);
    expect(rankResult(`Plextraktsync${ID_SEP}2`, "plex")).toBe(0.9);
    expect(rankResult(`Myplex${ID_SEP}3`, "plex")).toBe(0.7);
  });

  it("refuses a loose match, so loki does not return Kroki", () => {
    expect(rankResult(`Kroki${ID_SEP}1`, "loki")).toBe(0);
  });

  it("ignores the id suffix when scoring", () => {
    expect(rankResult(`Gitea${ID_SEP}abc123`, "abc123")).toBe(0);
  });

  it("matches everything on an empty query", () => {
    expect(rankResult(`Anything${ID_SEP}1`, "  ")).toBe(1);
  });
});

describe("byRelevance", () => {
  const apps = [
    { name: "Plextraktsync", keywords: [] as string[] },
    { name: "Plex", keywords: ["media"] },
  ];

  it("puts the exact name first", () => {
    const sorted = byRelevance(apps, "plex", (a) => [a.name, a.keywords]);
    expect(sorted[0].name).toBe("Plex");
  });

  it("leaves order alone when nothing is typed", () => {
    expect(byRelevance(apps, "", (a) => [a.name, a.keywords])).toBe(apps);
  });
});

describe("rankActions", () => {
  it("matches the verb before anything else", () => {
    expect(rankActions("restart").map((a) => a.id)).toEqual(["restart"]);
  });

  it("matches synonyms people actually type", () => {
    expect(rankActions("revert").map((a) => a.id)).toEqual(["rollback"]);
    expect(rankActions("redeploy").map((a) => a.id)).toEqual(["deploy"]);
    expect(rankActions("tail").map((a) => a.id)).toEqual(["logs"]);
  });

  it("matches rollback written as one word or two", () => {
    expect(rankActions("roll").map((a) => a.id)).toEqual(["rollback"]);
    expect(rankActions("rollback").map((a) => a.id)).toEqual(["rollback"]);
  });

  it("returns nothing for a query that names no action", () => {
    expect(rankActions("gitea")).toEqual([]);
  });

  it("offers every action before anything is typed", () => {
    expect(rankActions("")).toHaveLength(COMMAND_ACTIONS.length);
  });

  it("requires a confirm on everything that changes state", () => {
    for (const action of COMMAND_ACTIONS) {
      expect(Boolean(action.confirm), action.id).toBe(action.id !== "logs");
    }
  });
});

describe("fillApp", () => {
  it("substitutes every placeholder", () => {
    expect(fillApp("Restart {app}? {app} goes down.", "Gitea")).toBe(
      "Restart Gitea? Gitea goes down.",
    );
  });
});
