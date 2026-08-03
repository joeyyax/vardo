import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

import { CHART_COLORS } from "@/lib/metrics/constants";

const TOKENS = readFileSync(path.resolve(__dirname, "../../../../app/styles/tokens.css"), "utf8");
const THEME = readFileSync(path.resolve(__dirname, "../../../../app/styles/theme.css"), "utf8");

type Oklch = { l: number; c: number; h: number; a: number };

/** Body of the first rule whose selector matches, brace-balanced. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`unbalanced ${selector} block`);
}

function parseTokens(body: string): Record<string, Oklch> {
  const out: Record<string, Oklch> = {};
  const re =
    /(--[\w-]+):\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%\s*)?\)/g;
  for (const m of body.matchAll(re)) {
    out[m[1]] = {
      l: Number(m[2]) / 100,
      c: Number(m[3]),
      h: Number(m[4]),
      a: m[5] === undefined ? 1 : Number(m[5]) / 100,
    };
  }
  return out;
}

const light = parseTokens(block(TOKENS, ":root"));
const dark = parseTokens(block(TOKENS, ".dark"));

// --- Oklch -> sRGB ------------------------------------------------------

function linearSrgb({ l: L, c: C, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (t: Oklch) => linearSrgb(t).every((v) => v >= -0.001 && v <= 1.001);

const encode = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};
const decode = (s: number) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);

/** Gamma-encoded sRGB channels — what the compositor actually blends. */
const srgb = (t: Oklch): number[] => linearSrgb(t).map(encode);

/** `over` composited onto painted channels. Blending in linear light instead
    understates dark-mode ratios by about 1.3. */
const composite = (over: Oklch, under: number[]) =>
  srgb(over).map((v, i) => v * over.a + under[i] * (1 - over.a));

const luminanceOf = (channels: number[]) =>
  channels.map(decode).reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i] * v, 0);

function ratio(fg: number[], bg: number[]): number {
  const lf = luminanceOf(fg);
  const lb = luminanceOf(bg);
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

function contrast(fg: Oklch, bg: Oklch): number {
  const ground = srgb(bg);
  return ratio(composite(fg, ground), ground);
}

/** Oklab distance. ~0.02 is a large-patch just-noticeable difference. */
function deltaOk(a: Oklch, b: Oklch): number {
  const p = (t: Oklch) => {
    const r = (t.h * Math.PI) / 180;
    return [t.l, t.c * Math.cos(r), t.c * Math.sin(r)];
  };
  const [l1, a1, b1] = p(a);
  const [l2, a2, b2] = p(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Deuteranopia proxy — lightness and the blue-yellow axis survive. */
function deltaDeutan(a: Oklch, b: Oklch): number {
  const p = (t: Oklch) => [t.l, t.c * Math.sin((t.h * Math.PI) / 180)];
  const [l1, b1] = p(a);
  const [l2, b2] = p(b);
  return Math.hypot(l1 - l2, b1 - b2);
}

// --- The system ---------------------------------------------------------

/** One ladder, eight stops. Every axis draws from it. */
const LADDER = {
  "status-error": 25,
  "status-warning": 70,
  "env-tier": 110,
  "status-success": 155,
  "status-disposable": 200,
  "status-info": 240,
  "status-update": 288,
  "status-critical": 336,
};

/** Alarm stops. A chart series is never one of these. */
const ALARM_HUES = [25, 336];

const SERIES = [
  "chart-cpu",
  "chart-memory",
  "chart-network-rx",
  "chart-network-tx",
  "chart-disk",
  "chart-gpu-temperature",
];

/** Series pairs that can render on the same page. */
const CO_PRESENT: [string, string][] = [
  ["chart-cpu", "chart-memory"],
  ["chart-cpu", "chart-network-rx"],
  ["chart-cpu", "chart-network-tx"],
  ["chart-cpu", "chart-disk"],
  ["chart-cpu", "chart-gpu-temperature"],
  ["chart-memory", "chart-network-rx"],
  ["chart-memory", "chart-network-tx"],
  ["chart-memory", "chart-disk"],
  ["chart-memory", "chart-gpu-temperature"],
  ["chart-network-rx", "chart-network-tx"],
  ["chart-network-rx", "chart-disk"],
  ["chart-network-rx", "chart-gpu-temperature"],
  ["chart-network-tx", "chart-disk"],
  ["chart-network-tx", "chart-gpu-temperature"],
];

const grounds = {
  light: [light["--card"], light["--background"]],
  dark: [dark["--card"], dark["--background"]],
};

/** Every opaque ground a status chip lands on. */
const GROUNDS = [
  "card",
  "popover",
  "background",
  "background-deep",
  "muted",
  "secondary",
  "accent",
  "sidebar",
  "sidebar-accent",
];

const groundsOf = (T: Record<string, Oklch>) => GROUNDS.map((g) => T[`--${g}`]);

describe("colour ladder", () => {
  it("places every stop at least 40 degrees from its neighbours", () => {
    const hues = Object.values(LADDER).sort((a, b) => a - b);
    const gaps = hues.map((h, i) =>
      i === 0 ? h + 360 - hues[hues.length - 1] : h - hues[i - 1]
    );
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40);
  });

  it("declares each stop at its ladder hue in both themes", () => {
    for (const [name, hue] of Object.entries(LADDER)) {
      expect(light[`--${name}`], `${name} light`).toBeDefined();
      expect(dark[`--${name}`], `${name} dark`).toBeDefined();
      // Neutral is achromatic and has no place on the ladder.
      expect(light[`--${name}`].h, `${name} light hue`).toBe(hue);
      expect(dark[`--${name}`].h, `${name} dark hue`).toBe(hue);
    }
  });

  it("exposes every state and classification stop as a Tailwind colour", () => {
    for (const name of Object.keys(LADDER)) {
      expect(THEME, name).toContain(`--color-${name}: var(--${name});`);
      expect(THEME, `${name} muted`).toContain(
        `--color-${name}-muted: var(--${name}-muted);`
      );
    }
  });
});

describe("chart series tokens", () => {
  it("gives every series a light and a dark value", () => {
    for (const name of SERIES) {
      expect(light[`--${name}`], `${name} light`).toBeDefined();
      expect(dark[`--${name}`], `${name} dark`).toBeDefined();
    }
    for (const name of ["chart-reference", "chart-grid"]) {
      expect(light[`--${name}`], `${name} light`).toBeDefined();
      expect(dark[`--${name}`], `${name} dark`).toBeDefined();
    }
  });

  it("draws only from the ladder, never from an alarm stop", () => {
    const stops = Object.values(LADDER);
    for (const name of SERIES) {
      const hue = light[`--${name}`].h;
      expect(stops, `${name} is off-ladder`).toContain(hue);
      expect(ALARM_HUES, `${name} is an alarm hue`).not.toContain(hue);
      expect(dark[`--${name}`].h, `${name} shifts hue in dark`).toBe(hue);
    }
  });

  it("holds the state lightness band in both themes", () => {
    for (const name of SERIES) {
      expect(light[`--${name}`].l, `${name} light`).toBeGreaterThanOrEqual(0.45);
      expect(light[`--${name}`].l, `${name} light`).toBeLessThanOrEqual(0.52);
      expect(dark[`--${name}`].l, `${name} dark`).toBeGreaterThanOrEqual(0.7);
      expect(dark[`--${name}`].l, `${name} dark`).toBeLessThanOrEqual(0.75);
    }
  });

  it("keeps chroma inside sRGB so nothing is gamut mapped at paint", () => {
    for (const name of SERIES) {
      expect(inGamut(light[`--${name}`]), `${name} light`).toBe(true);
      expect(inGamut(dark[`--${name}`]), `${name} dark`).toBe(true);
    }
  });

  it("clears 3:1 against the card and the page in both themes", () => {
    for (const name of SERIES) {
      for (const [mode, bgs] of Object.entries(grounds)) {
        for (const bg of bgs) {
          expect(contrast(mode === "light" ? light[`--${name}`] : dark[`--${name}`], bg)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("separates every pair that can share a page", () => {
    for (const [a, b] of CO_PRESENT) {
      const full = Math.min(
        deltaOk(light[`--${a}`], light[`--${b}`]),
        deltaOk(dark[`--${a}`], dark[`--${b}`])
      );
      expect(full, `${a} vs ${b}`).toBeGreaterThanOrEqual(0.09);
    }
  });

  it("keeps the one pair sharing a chart apart under red-green CVD", () => {
    const d = Math.min(
      deltaDeutan(light["--chart-network-rx"], light["--chart-network-tx"]),
      deltaDeutan(dark["--chart-network-rx"], dark["--chart-network-tx"])
    );
    expect(d).toBeGreaterThanOrEqual(0.08);
  });
});

describe("limit and threshold references", () => {
  it("carries no hue", () => {
    expect(light["--chart-reference"].c).toBeLessThanOrEqual(0.012);
    expect(dark["--chart-reference"].c).toBeLessThanOrEqual(0.012);
  });

  it("stays quieter than every series it sits behind", () => {
    for (const name of SERIES) {
      expect(
        contrast(light["--chart-reference"], light["--card"]),
        `light vs ${name}`
      ).toBeLessThan(contrast(light[`--${name}`], light["--card"]));
    }
  });

  it("holds 4.5 on both grounds — it also labels the limit at 10px", () => {
    expect(contrast(light["--chart-reference"], light["--card"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark["--chart-reference"], dark["--card"])).toBeGreaterThanOrEqual(4.5);
  });

  it("is what memoryLimit resolves to", () => {
    expect(CHART_COLORS.memoryLimit).toBe(CHART_COLORS.reference);
    expect(CHART_COLORS.memoryLimit).toBe("var(--chart-reference)");
  });
});

describe("status dots", () => {
  it("clears 3:1 on the card in both themes", () => {
    const dots = ["status-success", "status-error", "status-warning", "status-info", "status-neutral"];
    for (const name of dots) {
      expect(contrast(light[`--${name}`], light["--card"]), `${name} light`).toBeGreaterThanOrEqual(3);
      expect(contrast(dark[`--${name}`], dark["--card"]), `${name} dark`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the environment tier clear of every health hue", () => {
    const health = ["status-success", "status-error", "status-warning", "status-info"];
    for (const name of health) {
      expect(light["--env-tier"].h, name).not.toBe(light[`--${name}`].h);
      expect(deltaOk(light["--env-tier"], light[`--${name}`]), `${name} light`).toBeGreaterThanOrEqual(0.08);
      expect(deltaOk(dark["--env-tier"], dark[`--${name}`]), `${name} dark`).toBeGreaterThanOrEqual(0.08);
    }
  });
});

/** Every stop with a -muted surface, whatever axis it belongs to. */
const SURFACED = [...Object.keys(LADDER), "status-neutral", "brass"];

describe("status surfaces", () => {
  it("declares an opaque surface for every stop", () => {
    for (const name of SURFACED) {
      for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
        const surface = T[`--${name}-muted`];
        expect(surface, `${name} ${mode}`).toBeDefined();
        // An alpha surface takes its contrast from whatever ancestor is behind
        // it — a hovered row, or a panel already tinted the same hue.
        expect(surface.a, `${name} ${mode} is an alpha tint`).toBe(1);
      }
    }
  });

  it("carries its own label at 4.5 and its own glyph at 3", () => {
    for (const name of SURFACED) {
      for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
        const r = contrast(T[`--${name}`], T[`--${name}-muted`]);
        expect(r, `${name} ${mode} label`).toBeGreaterThanOrEqual(4.5);
        expect(r, `${name} ${mode} glyph`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("stays a surface, not a second card", () => {
    for (const name of SURFACED) {
      for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
        const r = contrast(T[`--${name}-muted`], T["--card"]);
        expect(r, `${name} ${mode} vanishes on the card`).toBeGreaterThanOrEqual(1.1);
        expect(r, `${name} ${mode} outshouts the card`).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it("holds every stop inside sRGB, surface and all", () => {
    for (const name of SURFACED) {
      for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
        expect(inGamut(T[`--${name}`]), `${name} ${mode}`).toBe(true);
        expect(inGamut(T[`--${name}-muted`]), `${name} ${mode} surface`).toBe(true);
        expect(inGamut(T[`--${name}-edge`]), `${name} ${mode} edge`).toBe(true);
      }
    }
  });
});

describe("status edges", () => {
  it("declares an opaque edge for every surfaced stop", () => {
    for (const name of SURFACED) {
      for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
        const edge = T[`--${name}-edge`];
        expect(edge, `${name} ${mode}`).toBeDefined();
        expect(edge.a, `${name} ${mode} is an alpha line`).toBe(1);
        expect(edge.h, `${name} ${mode} shifts hue`).toBe(T[`--${name}`].h);
      }
    }
  });

  it("exposes every edge as a Tailwind colour", () => {
    for (const name of SURFACED) {
      expect(THEME, `${name} edge`).toContain(`--color-${name}-edge: var(--${name}-edge);`);
    }
  });

  // The fill can only sit at one lightness and the ground stack spans white
  // down to the hover accent, so on some grounds the fill matches and the chip
  // has no shape. An edge outside the stack has one ratio floor for every
  // ground, and for anything blended between two of them.
  it("sits outside the whole ground stack", () => {
    for (const name of SURFACED) {
      for (const g of groundsOf(light)) {
        expect(light[`--${name}-edge`].l, `${name} light`).toBeLessThan(g.l);
      }
      for (const g of groundsOf(dark)) {
        expect(dark[`--${name}-edge`].l, `${name} dark`).toBeGreaterThan(g.l);
      }
    }
  });

  it("clears 3 against every ground and against its own fill", () => {
    for (const name of SURFACED) {
      for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
        const edge = T[`--${name}-edge`];
        for (const [i, g] of groundsOf(T).entries()) {
          expect(contrast(edge, g), `${name} ${mode} on ${GROUNDS[i]}`).toBeGreaterThanOrEqual(3);
        }
        expect(
          contrast(edge, T[`--${name}-muted`]),
          `${name} ${mode} on its own fill`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("stays quieter than the label it frames", () => {
    for (const name of SURFACED) {
      for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
        const surface = T[`--${name}-muted`];
        expect(
          contrast(T[`--${name}-edge`], surface),
          `${name} ${mode} outshouts its label`
        ).toBeLessThan(contrast(T[`--${name}`], surface));
      }
    }
  });
});

describe("the status chip", () => {
  const BADGE = readFileSync(path.resolve(__dirname, "../../../../components/ui/badge.tsx"), "utf8");

  it("pairs every fill with its own edge and label", () => {
    for (const tone of ["success", "warning", "error", "info", "neutral"]) {
      expect(BADGE, tone).toContain(
        `border-status-${tone}-edge bg-status-${tone}-muted text-status-${tone}`
      );
    }
  });
});

describe("destructive", () => {
  it("declares a foreground that clears 4.5 on its own ground", () => {
    for (const [mode, T] of [["light", light], ["dark", dark]] as const) {
      expect(T["--destructive-foreground"], mode).toBeDefined();
      expect(
        contrast(T["--destructive-foreground"], T["--destructive"]),
        `${mode} destructive label`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is exposed as a Tailwind colour", () => {
    expect(THEME).toContain("--color-destructive-foreground: var(--destructive-foreground);");
  });
});

const ROOT = path.resolve(__dirname, "../../../..");

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe("status surfaces at the call sites", () => {
  const files = ["app", "components", "lib"].flatMap((d) => sources(path.join(ROOT, d)));

  it("never paints a status ground as an alpha of its own stop", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/bg-status-[a-z]+\/\d+/g)) {
        offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    // An alpha ground resolves against whatever is behind it, so the label on
    // top has no fixed ratio. Use the -muted surface.
    expect(offenders).toEqual([]);
  });

  it("never hand-rolls a chip that the badge variants already carry", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const tag of readFileSync(file, "utf8").matchAll(/<Badge\b[^>]*>/g)) {
        if (/bg-status-[a-z]+-muted/.test(tag[0])) offenders.push(path.relative(ROOT, file));
      }
    }
    // A fill without its edge disappears the moment the ground matches it.
    expect(offenders).toEqual([]);
  });

  it("never hand-rolls the label or the edge on its own", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const tag of readFileSync(file, "utf8").matchAll(/<Badge\b[^>]*>/g)) {
        if (/(?:text|border)-status-[a-z-]+/.test(tag[0])) {
          offenders.push(`${path.relative(ROOT, file)}: ${tag[0].replace(/\s+/g, " ")}`);
        }
      }
    }
    // A variant carries fill, edge and label together. An outline chip wearing
    // two of the three is a status chip with no ground under its label.
    expect(offenders).toEqual([]);
  });

  it("gives a status-toned button the variant that lets it own its hover", () => {
    // The other variants set their own hover:bg-*, which no status class
    // conflicts with, so it survives the merge and repaints on hover.
    const offenders: string[] = [];
    for (const file of files) {
      for (const tag of readFileSync(file, "utf8").matchAll(/<Button\b[\s\S]*?>/g)) {
        if (!/bg-status-[a-z]+-muted/.test(tag[0])) continue;
        // A ternary variant is fine as long as "status" is one of its arms.
        if (/variant=[^>]*"status"/.test(tag[0])) continue;
        offenders.push(`${path.relative(ROOT, file)}: ${tag[0].replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never paints a chip from outside the token set", () => {
    const PALETTE =
      /\b(?:bg|text|border|ring|from|to|via)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black)\b/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const tag of readFileSync(file, "utf8").matchAll(/<Badge\b[^>]*>/g)) {
        if (PALETTE.test(tag[0])) {
          offenders.push(`${path.relative(ROOT, file)}: ${tag[0].replace(/\s+/g, " ")}`);
        }
      }
    }
    // A raw palette stop does not move between themes and has no measured
    // ratio against any ground the app paints.
    expect(offenders).toEqual([]);
  });

  it("never re-tints a status surface on hover", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/hover:bg-status-[a-z-]+/g)) {
        offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("CHART_COLORS", () => {
  it("resolves entirely through declared tokens", () => {
    for (const [key, value] of Object.entries(CHART_COLORS)) {
      const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      expect(name, `${key} is not a token reference`).toBeDefined();
      expect(
        light[name!] !== undefined || TOKENS.includes(`${name}:`),
        `${key} references undeclared ${name}`
      ).toBe(true);
    }
  });

  it("points GPU utilization and memory at the metric they mirror", () => {
    expect(CHART_COLORS.gpuUtilization).toBe(CHART_COLORS.cpu);
    expect(CHART_COLORS.gpuMemory).toBe(CHART_COLORS.memory);
  });
});
