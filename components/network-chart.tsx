"use client";

import { useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { CHART_COLORS, chartTickStyle } from "@/lib/metrics/constants";
import {
  NETWORK_LABELS, formatRateTick, formatRateValue, hasNetworkSamples,
  networkDomain, networkTicks, type NetworkBarPoint,
} from "@/lib/metrics/network-chart";
import { TooltipFrame, TooltipRow } from "@/components/metrics-chart";

export type NetworkChartPoint = NetworkBarPoint & { time: string };

/** Keeps a near-idle sample visible instead of collapsing onto the center line. */
const MIN_BAR_PX = 2;

type Direction = "sent" | "received";

const DIRECTION_COLOR: Record<Direction, string> = {
  sent: CHART_COLORS.networkTx,
  received: CHART_COLORS.networkRx,
};

type BarShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: NetworkBarPoint;
};

function NetworkTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload?: NetworkBarPoint }[];
  label?: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  return (
    <TooltipFrame label={label}>
      <TooltipRow
        color={DIRECTION_COLOR.sent}
        label={`↑ ${NETWORK_LABELS.sent}`}
        value={formatRateValue(row.sentRate)}
      />
      <TooltipRow
        color={DIRECTION_COLOR.received}
        label={`↓ ${NETWORK_LABELS.received}`}
        value={formatRateValue(row.receivedRate)}
      />
    </TooltipFrame>
  );
}

function LegendChip({
  direction,
  arrow,
  onFocus,
}: {
  direction: Direction;
  arrow: string;
  onFocus: (d: Direction | null) => void;
}) {
  return (
    <span
      className="flex items-center gap-1.5"
      onMouseEnter={() => onFocus(direction)}
      onMouseLeave={() => onFocus(null)}
    >
      <span
        className="size-2 rounded-full shrink-0"
        style={{ backgroundColor: DIRECTION_COLOR[direction] }}
      />
      {arrow} {NETWORK_LABELS[direction]}
    </span>
  );
}

/**
 * Throughput as a diverging bar chart: sent above the center line, received
 * below it, on a symmetric axis. A sample with no reading draws no bar at all,
 * so a gap never reads as idle.
 */
export function NetworkChart({
  data,
  height = 200,
}: {
  data: NetworkChartPoint[];
  height?: number;
}) {
  const [focus, setFocus] = useState<Direction | null>(null);

  const domain = useMemo(() => networkDomain(data), [data]);
  const ticks = useMemo(() => networkTicks(domain[1]), [domain]);
  const hasSamples = useMemo(() => hasNetworkSamples(data), [data]);
  const hasGaps = useMemo(
    () => data.some((p) => p.sentRate === null || p.receivedRate === null),
    [data],
  );

  const shapeFor = (direction: Direction) =>
    function DivergingBar(props: BarShapeProps) {
      const { x = 0, y = 0, width = 0, height: barHeight = 0, payload } = props;
      const up = direction === "sent";
      // Null is absent, not idle. Nothing is drawn, so the column reads as a gap.
      const rate = up ? payload?.sentRate : payload?.receivedRate;
      if (rate === null || rate === undefined) return <g />;

      const top = Math.min(y, y + barHeight);
      const bottom = Math.max(y, y + barHeight);
      const size = Math.max(bottom - top, MIN_BAR_PX);

      return (
        <rect
          x={x}
          y={up ? bottom - size : top}
          width={width}
          height={size}
          fill={DIRECTION_COLOR[direction]}
          opacity={focus && focus !== direction ? 0.25 : 0.85}
          className="transition-opacity duration-150 motion-reduce:transition-none"
        />
      );
    };

  if (!hasSamples) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed"
        style={{ height }}
      >
        <p className="text-xs text-muted-foreground">No throughput collected in this range</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-[10px] text-muted-foreground">
        <LegendChip direction="sent" arrow="↑" onFocus={setFocus} />
        <LegendChip direction="received" arrow="↓" onFocus={setFocus} />
        {hasGaps && <span className="ml-auto">gaps: not collected</span>}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} barCategoryGap="8%" stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="time" tick={chartTickStyle} />
          <YAxis
            width={72}
            domain={domain}
            ticks={ticks}
            tickFormatter={formatRateTick}
            tick={chartTickStyle}
          />
          <ReferenceLine y={0} stroke={CHART_COLORS.tick} strokeWidth={1} />
          <Tooltip content={<NetworkTooltip />} cursor={{ fill: CHART_COLORS.grid }} />
          <Bar
            isAnimationActive={false}
            dataKey="sent"
            stackId="net"
            maxBarSize={20}
            shape={shapeFor("sent")}
          />
          <Bar
            isAnimationActive={false}
            dataKey="received"
            stackId="net"
            maxBarSize={20}
            shape={shapeFor("received")}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
