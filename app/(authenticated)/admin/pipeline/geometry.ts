// Map geometry: stop positions, each builder's lanes and the paths a deploy follows between stops.

import type { Stop } from "@/lib/pipeline/stops";
import type { PipelineBuilder } from "@/lib/pipeline/types";

export const MAIN = 0;
export const X: Record<Stop, number> = {
  queue: 70,
  gate: 220,
  build: 440,
  export: 610,
  swap: 800,
  health: 930,
  routing: 1035,
  live: 1130,
  rolledBack: 1035,
};
export const ROLLED_BACK_Y = MAIN + 130;

const LOCAL_GAP = 30;
const TARGET_GAP = 22;
const FIRST_TARGET_Y = MAIN + 110;
/** Room under a target's lanes for its labels. */
const TARGET_BLOCK_GAP = 78;
const MAX_LOCAL_LANES = 6;
const MAX_TARGET_LANES = 10;

export type Lane = { builder: string; index: number; y: number };
export type BuilderLayout = { builder: PipelineBuilder; lanes: Lane[]; top: number; bottom: number; local: boolean };

/** Lanes per builder: this server's fan above the main line, each target's sit below in its own block. */
export function layoutBuilders(builders: PipelineBuilder[]): BuilderLayout[] {
  let next = FIRST_TARGET_Y;
  return builders.map((b) => {
    const local = b.id === "local";
    const count = Math.min(Math.max(b.slots, b.holders.length, 1), local ? MAX_LOCAL_LANES : MAX_TARGET_LANES);
    const lanes = Array.from({ length: count }, (_, index): Lane => ({
      builder: b.id,
      index,
      y: local ? MAIN - index * LOCAL_GAP : next + index * TARGET_GAP,
    }));
    const ys = lanes.map((l) => l.y);
    const layout = { builder: b, lanes, top: Math.min(...ys), bottom: Math.max(...ys), local };
    if (!local) next = layout.bottom + TARGET_BLOCK_GAP;
    return layout;
  });
}

/** The whole lane: out of the gate, along its y, back in at the swap. */
export function lanePath(y: number): string {
  if (y === MAIN) return `M${X.gate},${MAIN} L${X.swap},${MAIN}`;
  return `M${X.gate},${MAIN} C${X.gate + 55},${MAIN} ${X.gate + 55},${y} ${X.gate + 110},${y} L${X.swap - 110},${y} C${X.swap - 55},${y} ${X.swap - 55},${MAIN} ${X.swap},${MAIN}`;
}

export const ROLLED_BACK_PATH = `M${X.health},${MAIN} C${X.health + 60},${MAIN} ${X.rolledBack - 60},${ROLLED_BACK_Y} ${X.rolledBack},${ROLLED_BACK_Y}`;

const ORDER: Stop[] = ["queue", "gate", "build", "export", "swap", "health", "routing", "live"];

export type Point = { x: number; y: number };

/** Where a stop sits for a deploy on lane y. */
export function stopPoint(stop: Stop, laneY: number): Point {
  if (stop === "rolledBack") return { x: X.rolledBack, y: ROLLED_BACK_Y };
  if (stop === "build" || stop === "export") return { x: X[stop], y: laneY };
  return { x: X[stop], y: MAIN };
}

/** The path from one stop to a later one along the deploy's lane, starting from where its pill is drawn. */
export function routeBetween(from: Stop, to: Stop, laneY: number, start: Point, end: Point): string {
  const d = [`M${start.x.toFixed(1)},${start.y.toFixed(1)}`];
  const a = ORDER.indexOf(from === "rolledBack" ? "health" : from);
  const target = to === "rolledBack" ? "health" : to;
  const b = ORDER.indexOf(target);
  if (a === -1 || b === -1 || b < a) {
    // Back along the map, as when a build falls back to this server: one smooth curve.
    const mx = (start.x + end.x) / 2;
    d.push(`C${mx + 40},${start.y} ${mx + 40},${end.y} ${end.x},${end.y}`);
    return d.join(" ");
  }
  const first = stopPoint(ORDER[a], laneY);
  d.push(`L${first.x},${first.y}`);
  for (let i = a; i < b; i++) {
    const step = `${ORDER[i]}>${ORDER[i + 1]}`;
    if (step === "gate>build" && laneY !== MAIN) {
      d.push(`C${X.gate + 55},${MAIN} ${X.gate + 55},${laneY} ${X.gate + 110},${laneY} L${X.build},${laneY}`);
    } else if (step === "export>swap" && laneY !== MAIN) {
      d.push(`L${X.swap - 110},${laneY} C${X.swap - 55},${laneY} ${X.swap - 55},${MAIN} ${X.swap},${MAIN}`);
    } else if (step === "gate>build" || step === "build>export" || step === "export>swap") {
      const p = stopPoint(ORDER[i + 1], laneY);
      d.push(`L${p.x},${p.y}`);
    } else {
      d.push(`L${X[ORDER[i + 1]]},${MAIN}`);
    }
  }
  if (to === "rolledBack") d.push(ROLLED_BACK_PATH.replace(/^M[^ ]+ /, ""));
  if (end.x !== stopPoint(to, laneY).x || end.y !== stopPoint(to, laneY).y) d.push(`L${end.x},${end.y}`);
  return d.join(" ");
}
