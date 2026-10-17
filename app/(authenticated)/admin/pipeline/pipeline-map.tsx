"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import type { Stop } from "@/lib/pipeline/stops";
import type { PipelineDeploy, PipelineSnapshot } from "@/lib/pipeline/types";
import {
  MAIN,
  ROLLED_BACK_PATH,
  ROLLED_BACK_Y,
  X,
  lanePath,
  layoutBuilders,
  routeBetween,
  stopPoint,
  type BuilderLayout,
  type Lane,
  type Point,
} from "./geometry";

const C = {
  ink: "var(--foreground)",
  muted: "var(--muted-foreground)",
  rule: "var(--border)",
  paper: "var(--card)",
  ground: "var(--background)",
  remote: "var(--status-success)",
  fail: "var(--status-error)",
  wait: "var(--status-warning)",
};

const STACK_GAP = 22;
/** Pixels per second a pill moves. */
const SPEED = 260;
/** Finished deploys fade this long after they finish. */
const LIVE_FADE_MS = 18_000;
const FAILED_FADE_MS = 8_000;
const MAX_STACK = 5;

type Pill = {
  key: string;
  name: string;
  stop: Stop;
  waiting: boolean;
  lane: Lane | null;
  faded: boolean;
};

type Placed = Pill & { point: Point; laneY: number };

/** Keeps each slot holder on its lane between snapshots; a new holder takes the lowest free lane. */
export function assignLanes(prev: Map<string, Lane>, layouts: BuilderLayout[]): Map<string, Lane> {
  const next = new Map<string, Lane>();
  for (const layout of layouts) {
    const keys = layout.builder.holders.map((h) => h.deploymentId ?? h.token);
    const taken = new Set<number>();
    for (const key of keys) {
      const had = prev.get(key);
      if (had && had.builder === layout.builder.id && had.index < layout.lanes.length && !taken.has(had.index)) {
        next.set(key, layout.lanes[had.index]);
        taken.add(had.index);
      }
    }
    for (const key of keys) {
      if (next.has(key)) continue;
      const free = layout.lanes.find((l) => !taken.has(l.index));
      if (!free) continue;
      next.set(key, free);
      taken.add(free.index);
    }
  }
  return next;
}

export type PipelineLanes = {
  layouts: BuilderLayout[];
  /** Lanes held now, by deployment id or, for a linked instance's build, its token. */
  lanes: Map<string, Lane>;
  /** The last lane each deploy held, so it rides that lane back to the swap. */
  last: Map<string, Lane>;
};

/** Builder layouts and each slot holder's lane, stable across snapshots. */
export function usePipelineLanes(snapshot: PipelineSnapshot | null): PipelineLanes {
  const prev = useRef<{ lanes: Map<string, Lane>; last: Map<string, Lane> }>({ lanes: new Map(), last: new Map() });
  const layouts = useMemo(() => layoutBuilders(snapshot?.builders ?? []), [snapshot?.builders]);
  // eslint-disable-next-line react-hooks/refs
  const result = useMemo(() => nextLanes(prev.current, layouts, snapshot), [layouts, snapshot]);
  useLayoutEffect(() => {
    prev.current = result;
  }, [result]);
  return { layouts, ...result };
}

function nextLanes(prev: { lanes: Map<string, Lane>; last: Map<string, Lane> }, layouts: BuilderLayout[], snapshot: PipelineSnapshot | null) {
  const lanes = assignLanes(prev.lanes, layouts);
  const ids = new Set((snapshot?.deploys ?? []).map((d) => d.id));
  const builders = new Set(layouts.map((l) => l.builder.id));
  const last = new Map<string, Lane>();
  for (const [id, lane] of prev.last) if (ids.has(id) && builders.has(lane.builder)) last.set(id, lane);
  for (const [id, lane] of lanes) if (ids.has(id)) last.set(id, lane);
  return { lanes, last };
}

type Anim = { path: SVGPathElement; len: number; t0: number; dur: number };

function currentPoint(anim: Anim, t: number): Point {
  const k = Math.min(1, Math.max(0, (t - anim.t0) / anim.dur));
  const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const pt = anim.path.getPointAtLength(eased * anim.len);
  return { x: pt.x, y: pt.y };
}

function pillWidth(name: string): number {
  return name.length * 6.3 + 16;
}

function shortName(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

type MapProps = { snapshot: PipelineSnapshot; now: number } & PipelineLanes;

export function PipelineMap({ snapshot, now, layouts, lanes, last }: MapProps) {
  const local = layouts[0];
  const targets = layouts.slice(1);

  const pills = useMemo((): Pill[] => {
    const list: Pill[] = snapshot.deploys
      .filter((d) => !d.gone)
      .map((d: PipelineDeploy) => {
        const lane = last.get(d.id) ?? null;
        const age = d.finishedAt === null ? 0 : now - d.finishedAt;
        return {
          key: d.id,
          name: shortName(d.appName),
          stop: d.stop,
          waiting: d.waiting,
          lane,
          faded: d.finishedAt !== null && age > (d.failed ? FAILED_FADE_MS : LIVE_FADE_MS),
        };
      });
    // Linked instances' builds hold lanes here without a deploy of ours.
    for (const b of snapshot.builders) {
      for (const h of b.holders) {
        if (h.deploymentId) continue;
        list.push({ key: h.token, name: "linked build", stop: "build", waiting: false, lane: lanes.get(h.token) ?? null, faded: false });
      }
    }
    return list;
  }, [snapshot, lanes, last, now]);

  const placed = useMemo((): Placed[] => {
    const stacks = new Map<string, number>();
    return pills.map((p) => {
      const laneY = p.lane?.y ?? MAIN;
      const base = stopPoint(p.stop, laneY);
      const onLane = p.stop === "build" || p.stop === "export";
      const key = onLane ? `${p.stop}:${laneY}` : p.stop;
      const i = stacks.get(key) ?? 0;
      stacks.set(key, i + 1);
      const shown = Math.min(i, MAX_STACK);
      return { ...p, laneY, point: { x: base.x, y: base.y + shown * (onLane ? 0 : STACK_GAP) } };
    });
  }, [pills]);

  const svgRef = useRef<SVGSVGElement>(null);
  const measureRef = useRef<SVGGElement>(null);
  const nodes = useRef(new Map<string, SVGGElement>());
  const state = useRef(new Map<string, { at: Point; stop: Stop; laneY: number; anim: Anim | null }>());
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const measure = measureRef.current;
    const seen = new Set<string>();
    for (const p of placed) {
      seen.add(p.key);
      const node = nodes.current.get(p.key);
      const prev = state.current.get(p.key);
      const draw = (pt: Point) => node?.setAttribute("transform", `translate(${pt.x.toFixed(1)},${pt.y.toFixed(1)})`);
      if (!prev || reduced || !measure) {
        state.current.set(p.key, { at: p.point, stop: p.stop, laneY: p.laneY, anim: null });
        draw(p.point);
        continue;
      }
      if (prev.stop === p.stop && prev.at.x === p.point.x && prev.at.y === p.point.y) {
        if (!prev.anim) draw(p.point);
        continue;
      }
      const from = prev.anim ? currentPoint(prev.anim, performance.now()) : prev.at;
      const d =
        prev.stop === p.stop
          ? `M${from.x},${from.y} L${p.point.x},${p.point.y}`
          : routeBetween(prev.stop, p.stop, p.laneY, from, p.point);
      prev.anim?.path.remove();
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      measure.appendChild(path);
      const len = path.getTotalLength();
      state.current.set(p.key, {
        at: p.point,
        stop: p.stop,
        laneY: p.laneY,
        anim: { path, len, t0: performance.now(), dur: Math.max(300, (len / SPEED) * 1000) },
      });
    }
    for (const [key, s] of state.current) {
      if (seen.has(key)) continue;
      s.anim?.path.remove();
      state.current.delete(key);
    }

    const tick = (t: number) => {
      let moving = false;
      for (const [key, s] of state.current) {
        if (!s.anim) continue;
        const node = nodes.current.get(key);
        const k = Math.min(1, (t - s.anim.t0) / s.anim.dur);
        const pt = currentPoint(s.anim, t);
        node?.setAttribute("transform", `translate(${pt.x.toFixed(1)},${pt.y.toFixed(1)})`);
        if (k >= 1) {
          s.anim.path.remove();
          s.anim = null;
          node?.setAttribute("transform", `translate(${s.at.x},${s.at.y})`);
        } else moving = true;
      }
      frame.current = moving ? requestAnimationFrame(tick) : null;
    };
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [placed]);

  useLayoutEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  const busyLanes = new Set([...lanes.values()].map((l) => `${l.builder}:${l.index}`));
  const top = local.top - 78;
  const lastTarget = targets[targets.length - 1];
  const bottom = Math.max(lastTarget ? lastTarget.bottom + 70 : MAIN + 130, ROLLED_BACK_Y + 48, MAIN + STACK_GAP * MAX_STACK + 30);
  const firstTarget = targets[0];

  return (
    <svg
      ref={svgRef}
      viewBox={`0 ${top} 1200 ${bottom - top}`}
      className="block h-auto w-full min-w-[860px]"
      role="img"
      aria-label={`Deploy pipeline map: ${snapshot.deploys.length} deploys, ${snapshot.builders.length} builders`}
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={`M${X.queue},${MAIN} L${X.gate},${MAIN}`} style={{ stroke: C.ink }} strokeWidth={8} />
        <path d={`M${X.swap},${MAIN} L${X.live},${MAIN}`} style={{ stroke: C.ink }} strokeWidth={8} />
        <path d={ROLLED_BACK_PATH} style={{ stroke: C.fail }} strokeWidth={5} />
        {layouts.map((layout) => (
          <g key={layout.builder.id} style={{ opacity: layout.builder.online === false ? 0.3 : 1, transition: "opacity 0.4s" }}>
            {layout.lanes.map((lane) => {
              const busy = busyLanes.has(`${lane.builder}:${lane.index}`);
              const main = layout.local && lane.index === 0;
              const stroke = main || (busy && layout.local) ? C.ink : busy ? C.remote : C.rule;
              return (
                <path
                  key={lane.index}
                  d={lanePath(lane.y)}
                  style={{ stroke, transition: "stroke 0.3s, stroke-width 0.3s" }}
                  strokeWidth={main || (busy && layout.local) ? 8 : busy ? 6 : 4}
                />
              );
            })}
          </g>
        ))}
        {firstTarget && (
          <path
            d={`M${X.build},${firstTarget.top - 12} L${X.build},${MAIN + 14}`}
            style={{ stroke: C.muted }}
            strokeWidth={2.5}
            strokeDasharray="2 7"
          />
        )}
      </g>
      {firstTarget && (
        <text x={X.build + 12} y={(firstTarget.top + MAIN) / 2 + 4} className="font-mono" style={{ fill: C.muted, fontSize: 11 }}>
          falls back to {snapshot.instanceName}
        </text>
      )}

      <g>
        {(["queue", "gate", "swap", "health", "routing", "live", "rolledBack"] as Stop[]).map((stop) => {
          const pt = stopPoint(stop, MAIN);
          const hub = stop === "gate" || stop === "swap";
          const term = stop === "queue" || stop === "live" || stop === "rolledBack";
          return (
            <g key={stop}>
              {hub ? (
                <rect x={pt.x - 9} y={pt.y - 17} width={18} height={34} rx={9} style={{ fill: C.paper, stroke: C.ink }} strokeWidth={3} />
              ) : (
                <circle cx={pt.x} cy={pt.y} r={term ? 11 : 8} style={{ fill: C.paper, stroke: stop === "rolledBack" ? C.fail : C.ink }} strokeWidth={3} />
              )}
              <text
                x={pt.x}
                y={stop === "rolledBack" ? pt.y + 34 : pt.y - 28}
                textAnchor="middle"
                style={{ fill: C.ink, fontSize: 13, fontWeight: 700 }}
              >
                {STOP_NAMES[stop]}
              </text>
            </g>
          );
        })}
        {layouts.map((layout) => {
          const b = layout.builder;
          const busy = b.holders.length;
          const above = layout.local;
          const note = b.online === false ? "offline" : `${busy} of ${b.slots} slot${b.slots === 1 ? "" : "s"} busy`;
          return [
            { x: X.build, label: `Build · ${b.name}`, note },
            { x: X.export, label: layout.local ? "Export" : "Build registry", note: layout.local ? "" : "or over SSH" },
          ].map((bar) => (
            <g key={`${b.id}:${bar.x}`}>
              <rect
                x={bar.x - 8}
                y={layout.top - 11}
                width={16}
                height={layout.bottom - layout.top + 22}
                rx={8}
                style={{ fill: C.paper, stroke: C.ink }}
                strokeWidth={3}
              />
              <text x={bar.x} y={above ? layout.top - 46 : layout.bottom + 36} textAnchor="middle" style={{ fill: C.ink, fontSize: 13, fontWeight: 700 }}>
                {bar.label}
              </text>
              {bar.note && (
                <text x={bar.x} y={above ? layout.top - 30 : layout.bottom + 52} textAnchor="middle" className="font-mono" style={{ fill: C.muted, fontSize: 11 }}>
                  {bar.note}
                </text>
              )}
            </g>
          ));
        })}
      </g>

      <g ref={measureRef} style={{ visibility: "hidden" }} aria-hidden />

      <g>
        {placed.map((p) => {
          const w = pillWidth(p.name);
          return (
            <g
              key={p.key}
              ref={(el) => {
                if (el) nodes.current.set(p.key, el);
                else nodes.current.delete(p.key);
              }}
              style={{ opacity: p.faded ? 0 : 1, transition: "opacity 0.6s" }}
            >
              <rect
                x={-w / 2}
                y={-9}
                width={w}
                height={18}
                rx={9}
                style={{ fill: C.ink, stroke: p.waiting ? C.wait : C.paper }}
                strokeWidth={2}
                strokeDasharray={p.waiting ? "4 3" : undefined}
              />
              <text x={0} y={1} textAnchor="middle" dominantBaseline="central" className="font-mono" style={{ fill: C.ground, fontSize: 10.5, fontWeight: 600 }}>
                {p.name}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

const STOP_NAMES: Record<Stop, string> = {
  queue: "Queue",
  gate: "Slot gate",
  build: "Build",
  export: "Export",
  swap: "Swap",
  health: "Health check",
  routing: "Routing",
  live: "Live",
  rolledBack: "Rolled back",
};
