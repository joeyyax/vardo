"use client";

import type { JobKind, PipelineJob } from "@/lib/pipeline/types";

const C = {
  ink: "var(--foreground)",
  muted: "var(--muted-foreground)",
  paper: "var(--card)",
  ground: "var(--background)",
};

const START_X = 190;
const END_X = 1110;

/** Each track's stops. A step drawn as a bar spans two stops: the dump streams straight into the upload. */
const TRACKS: { kind: JobKind; label: string; y: number; stops: { label: string; x: number; to?: { label: string; x: number } }[] }[] = [
  {
    kind: "backup",
    label: "Backups",
    y: 50,
    stops: [
      { label: "Dump", x: 340, to: { label: "Upload", x: 580 } },
      { label: "Verify", x: 820 },
      { label: "Done", x: END_X },
    ],
  },
  {
    kind: "drill",
    label: "Restore drills",
    y: 125,
    stops: [
      { label: "Restore", x: 340, to: { label: "Check", x: 580 } },
      { label: "Done", x: END_X },
    ],
  },
  { kind: "cron", label: "Cron runs", y: 200, stops: [{ label: "Run", x: 580 }, { label: "Done", x: END_X }] },
];

const FADE_MS = 12_000;

function stepX(kind: JobKind, step: number): number {
  const stop = TRACKS.find((t) => t.kind === kind)!.stops[step];
  if (!stop) return END_X;
  return stop.to ? (stop.x + stop.to.x) / 2 : stop.x;
}

export function PipelineJobs({ jobs, now }: { jobs: PipelineJob[]; now: number }) {
  const stacks = new Map<string, number>();
  return (
    <svg
      viewBox="0 0 1200 240"
      className="block h-auto w-full min-w-[860px]"
      role="img"
      aria-label={`Backups, restore drills and cron runs: ${jobs.filter((j) => j.finishedAt === null).length} in progress`}
    >
      {TRACKS.map((t) => (
        <g key={t.kind}>
          <text x={16} y={t.y + 5} style={{ fill: C.ink, fontSize: 13, fontWeight: 700 }}>
            {t.label}
          </text>
          <path d={`M${START_X},${t.y} L${END_X},${t.y}`} style={{ stroke: C.ink }} strokeWidth={5} strokeLinecap="round" />
          <circle cx={START_X} cy={t.y} r={6} style={{ fill: C.paper, stroke: C.ink }} strokeWidth={3} />
          {t.stops.map((s) => (
            <g key={s.label}>
              {s.to ? (
                <>
                  <rect x={s.x - 7} y={t.y - 7} width={s.to.x - s.x + 14} height={14} rx={7} style={{ fill: C.paper, stroke: C.ink }} strokeWidth={3} />
                  <text x={s.to.x} y={t.y - 16} textAnchor="middle" className="font-mono" style={{ fill: C.muted, fontSize: 11 }}>
                    {s.to.label}
                  </text>
                </>
              ) : (
                <circle cx={s.x} cy={t.y} r={s.x === END_X ? 9 : 7} style={{ fill: C.paper, stroke: C.ink }} strokeWidth={3} />
              )}
              <text x={s.x} y={t.y - 16} textAnchor="middle" className="font-mono" style={{ fill: C.muted, fontSize: 11 }}>
                {s.label}
              </text>
            </g>
          ))}
        </g>
      ))}
      {jobs.map((job) => {
        const track = TRACKS.find((t) => t.kind === job.kind)!;
        const key = `${job.kind}:${job.step}`;
        const i = stacks.get(key) ?? 0;
        stacks.set(key, i + 1);
        const name = job.name.length > 28 ? `${job.name.slice(0, 27)}…` : job.name;
        const w = name.length * 6.3 + 16;
        const faded = job.finishedAt !== null && now - job.finishedAt > FADE_MS;
        return (
          <g
            key={job.id}
            style={{
              transform: `translate(${stepX(job.kind, job.step)}px, ${track.y + Math.min(i, 2) * 20}px)`,
              transition: "transform 1.2s ease-in-out, opacity 0.6s",
              opacity: faded ? 0 : 1,
            }}
          >
            <rect x={-w / 2} y={-9} width={w} height={18} rx={9} style={{ fill: C.ink, stroke: C.paper }} strokeWidth={2} />
            <text x={0} y={1} textAnchor="middle" dominantBaseline="central" className="font-mono" style={{ fill: C.ground, fontSize: 10.5, fontWeight: 600 }}>
              {name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
