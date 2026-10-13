import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { render } from "react-email";
import {
  blockGap,
  blockText,
  columnBase,
  columnHeights,
  errorLines,
  gaugeFill,
  hourLabel,
  hourLevels,
  linkedList,
  NotificationMail,
  notificationMailText,
  phaseLabelFits,
  richText,
  sparkHeights,
  tileValueSize,
  visualText,
  type NotificationMailBody,
} from "@/lib/email/templates/components";
import { KIT_SAMPLES } from "@/lib/email/kit-fixture";

const kit = KIT_SAMPLES.find((s) => s.name === "kit")!.body;

describe("gauge", () => {
  it("colors the fill by threshold", () => {
    expect(gaugeFill(60, 85, 95)).toBe("ok");
    expect(gaugeFill(85, 85, 95)).toBe("warn");
    expect(gaugeFill(94.9, 85, 95)).toBe("warn");
    expect(gaugeFill(95, 85, 95)).toBe("fail");
  });

  it("states the thresholds in text", () => {
    expect(visualText({ kind: "gauge", percent: 91.4, warn: 85, critical: 95, label: "204 of 223.4 GiB" })).toBe(
      "91% 204 of 223.4 GiB [##################--] (alerts at 85%, critical at 95%)",
    );
  });
});

describe("tiles", () => {
  it("keeps short values at full size and shrinks long ones", () => {
    expect(tileValueSize("6", "/6")).toBe(22);
    expect(tileValueSize("1m 32s")).toBe(22);
    expect(tileValueSize("1,104", "/1,130")).toBe(22);
    expect(tileValueSize("12,345,678", " GiB")).toBeLessThan(22);
    expect(tileValueSize("a-very-long-tile-value")).toBe(16);
  });
});

describe("phase labels", () => {
  it("labels only segments wide enough", () => {
    expect(phaseLabelFits(69, "Build", "1m 04s")).toBe(true);
    expect(phaseLabelFits(14, "Health", "13s")).toBe(true);
    expect(phaseLabelFits(5, "Pull", "5s")).toBe(false);
    expect(phaseLabelFits(9, "Health check", "2m 15s")).toBe(false);
  });

  it("marks the failed step in text", () => {
    const text = visualText({ kind: "phases", steps: [{ label: "Pull", value: 8, detail: "8s" }, { label: "Health", value: 59, detail: "59s", failed: true }] });
    expect(text).toBe("Pull 8s · Health 59s ✗");
  });
});

describe("columns", () => {
  it("trims the baseline only when every value sits high", () => {
    expect(columnBase([150, 165], "auto")).toBe(135);
    expect(columnBase([10, 165], "auto")).toBe(0);
    expect(columnBase([150, 165])).toBe(0);
    const trimmed = columnHeights([150, 165], 60, "auto");
    expect(trimmed[1]).toBe(60);
    expect(trimmed[0]).toBe(30);
    expect(columnHeights([150, 165], 60)[0]).toBe(55);
  });

  it("gives tiny values a visible stub and zero none", () => {
    expect(columnHeights([0, 1, 100], 60)).toEqual([0, 3, 60]);
    expect(columnHeights([0, 0], 60)).toEqual([0, 0]);
  });

  it("scales stats sparks from min to max", () => {
    expect(sparkHeights([10, 20, 30])).toEqual([4, 13, 22]);
  });
});

describe("hour strip", () => {
  it("maps values onto a 5-step ramp, any activity at least 1", () => {
    expect(hourLevels([0, 1, 50, 100])).toEqual([0, 1, 2, 4]);
    expect(hourLevels([0, 0])).toEqual([0, 0]);
  });

  it("names hours and the busiest one", () => {
    expect([0, 9, 12, 18, 23].map(hourLabel)).toEqual(["12 am", "9 am", "noon", "6 pm", "11 pm"]);
    const values = Array.from({ length: 24 }, (_, h) => (h === 19 ? 10 : 1));
    expect(visualText({ kind: "hours", title: "Busiest hours", values })).toContain("busiest around 7 pm");
  });
});

describe("log block", () => {
  it("highlights the last error line", () => {
    expect(errorLines(["Starting", "Error: boom", "exited with code 1"])).toEqual([1]);
    expect(errorLines(["ok", "fine"])).toEqual([]);
    expect(blockText({ kind: "log", title: "Output", lines: ["Starting", "PHP Fatal error: memory"] })).toBe("Output\n    Starting\n  > PHP Fatal error: memory");
    expect(blockText({ kind: "log", lines: ["sudo vardo update"], highlight: [] })).toBe("    sudo vardo update");
  });
});

describe("inline content", () => {
  it("joins linked names without an Oxford comma", () => {
    expect(richText(linkedList([{ text: "a", href: "x" }, { text: "b" }, { text: "c" }]))).toBe("a, b and c");
    expect(richText(linkedList([{ text: "a" }, { text: "b" }]))).toBe("a and b");
  });

  it("marks new chips in text once", () => {
    expect(blockText({ kind: "chips", chips: [{ text: "tcp/3000" }, { text: "tcp/8080", new: true }, { text: "worker · new", new: true }] })).toBe(
      "tcp/3000, tcp/8080 (new), worker · new",
    );
  });
});

describe("block text", () => {
  it("writes callouts, tiles, stats, days and the timeline", () => {
    expect(blockText({ kind: "callout", tone: "bad", title: "PHP ran out of memory", body: "Raise memory_limit.", action: { label: "Run history", href: "https://x/cron" } })).toBe(
      "✗ PHP ran out of memory\nRaise memory_limit.\nRun history: https://x/cron",
    );
    expect(blockText({ kind: "tiles", tiles: [{ label: "Size", value: "9.8", unit: " GiB", sub: "+1%" }] })).toBe("Size: 9.8 GiB (+1%)");
    expect(blockText({ kind: "stats", columns: ["App", "CPU", "Memory"], rows: [{ name: "Shop", sub: "wordpress", why: "Killed twice", cells: ["3%", { value: "1 GB", hot: true }] }] })).toBe(
      "Shop (wordpress): CPU 3% · Memory 1 GB\n  Killed twice",
    );
    expect(visualText({ kind: "days", days: ["ok", "ok", "fail"] })).toBe("✓✓✗ 2 succeeded, 1 failed");
    expect(blockText({ kind: "timeline", current: 1, steps: [{ label: "Deployed", date: "Oct 13" }, { label: "Baseline set", date: "Oct 16" }, { label: "First month", date: "Nov 12" }] })).toBe(
      "✓ Deployed Oct 13 → ● Baseline set Oct 16 → ○ First month Nov 12",
    );
  });

  it("spaces section headings and stacked callouts", () => {
    expect(blockGap(undefined, "text")).toBe(0);
    expect(blockGap("text", "section")).toBe(26);
    expect(blockGap("section", "columns")).toBe(10);
    expect(blockGap("callout", "callout")).toBe(10);
    expect(blockGap("callout", "tiles")).toBe(20);
  });
});

describe("layout", () => {
  it("renders every primitive as tables with no badge, images or scripts", async () => {
    const html = await render(createElement(NotificationMail, kit));
    expect(html).not.toMatch(/<svg|<script|<img|display:\s*(flex|grid)|background-image/i);
    expect(html).not.toContain("vd-badge-info\"");
    expect(html).toContain("vd-callout-bad");
    expect(html).toContain("vd-chip-new");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toMatch(/@media \(max-width:480px\)[^}]*\.vd-tile/);
  });

  it("puts section titles on the block after them in text, and footer links last", () => {
    const body: NotificationMailBody = {
      tone: "fail",
      status: "Failed",
      heading: "sync-orders failed",
      blocks: [
        { kind: "reassure", strong: "Nothing is down.", text: "The previous version is still serving." },
        { kind: "section", title: "Last 24 runs" },
        { kind: "days", days: ["ok", "fail"] },
      ],
      action: { label: "Open the cron job", href: "https://x/cron" },
      links: [{ label: "App logs", href: "https://x/logs" }],
      footer: { instanceName: "node-a", consoleHost: "vardo.example.com", settingsUrl: "https://x/settings", note: "Next recap in 30 days." },
    };
    expect(notificationMailText(body)).toBe(
      [
        "sync-orders failed",
        "Nothing is down. The previous version is still serving.",
        "Last 24 runs\n✓✗ 1 succeeded, 1 failed",
        "Open the cron job: https://x/cron\nApp logs: https://x/logs",
        "--\nNext recap in 30 days.\nNotification settings: https://x/settings\nSent by Vardo on node-a (vardo.example.com).",
      ].join("\n\n") + "\n",
    );
  });
});
