"use client";

/**
 * Small inline-SVG charts (no chart library).
 *
 * Following the dataviz method: one axis per chart (volume and rate are
 * separate charts, never a dual axis), single-series charts carry no legend
 * box (the title names the series), bars ≤ 24px with a 4px rounded data end
 * and square baseline, 2px lines with round joins, recessive grid, a hover
 * tooltip on every mark, and a table view for screen readers / exact values.
 * Days with no value (e.g. insufficient sample) are GAPS, never zero.
 */
import { useState } from "react";

export type ValueFormat = "count" | "percent";

/** Serializable formatter choice — server components cannot pass functions to client components. */
function formatter(kind: ValueFormat): (v: number) => string {
  return kind === "percent" ? (v) => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%` : (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
}

export interface SeriesPoint {
  label: string; // YYYY-MM-DD
  value: number | null;
  note?: string;
}

const W = 640;
const H = 180;
const PAD = { l: 44, r: 12, t: 12, b: 26 };

function ticks(max: number, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function Frame({ title, children, table }: { title: string; children: React.ReactNode; table: React.ReactNode }) {
  return (
    <figure className="w-full">
      <figcaption className="mb-2 text-xs font-medium text-muted">{title}</figcaption>
      {children}
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer select-none">Table view</summary>
        <div className="mt-2 max-h-56 overflow-auto">{table}</div>
      </details>
    </figure>
  );
}

function DataTable({ points, format }: { points: SeriesPoint[]; format: (v: number) => string }) {
  return (
    <table className="w-full text-left">
      <thead>
        <tr>
          <th className="py-1 pr-4 font-medium">Day (UTC)</th>
          <th className="py-1 font-medium">Value</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.label}>
            <td className="py-0.5 pr-4">{p.label}</td>
            <td className="py-0.5">{p.value === null ? (p.note ?? "no data") : format(p.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BarChart({ title, points, format: kind = "count", color = "var(--series-1)" }: { title: string; points: SeriesPoint[]; format?: ValueFormat; color?: string }) {
  const format = formatter(kind);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  const ts = ticks(max);
  const top = ts[ts.length - 1] ?? max;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const band = innerW / Math.max(1, points.length);
  const barW = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  const hp = hover !== null ? points[hover] : null;

  return (
    <Frame title={title} table={<DataTable points={points} format={format} />}>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}. Use the table view for exact values.`} onMouseLeave={() => setHover(null)}>
          {ts.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {format(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = PAD.l + i * band + (band - barW) / 2;
            const v = p.value ?? 0;
            const h = Math.max(0, y(0) - y(v));
            const r = Math.min(4, h, barW / 2);
            return (
              <g key={p.label} onMouseEnter={() => setHover(i)}>
                <rect x={PAD.l + i * band} y={PAD.t} width={band} height={innerH} fill="transparent" />
                {p.value !== null && h > 0 ? (
                  <path
                    d={`M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z`}
                    fill={color}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                ) : null}
              </g>
            );
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--panel-border)" />
          {points.map((p, i) =>
            i % Math.ceil(points.length / 6) === 0 ? (
              <text key={p.label} x={PAD.l + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                {p.label.slice(5)}
              </text>
            ) : null,
          )}
        </svg>
        {hp ? (
          <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-line bg-panel px-2 py-1 text-xs shadow-sm">
            <div className="text-muted">{hp.label}</div>
            <div className="font-medium text-ink">{hp.value === null ? (hp.note ?? "No data") : format(hp.value)}</div>
          </div>
        ) : null}
      </div>
    </Frame>
  );
}

export function LineChart({ title, points, format: kind = "count", color = "var(--series-1)", domainMax }: { title: string; points: SeriesPoint[]; format?: ValueFormat; color?: string; domainMax?: number }) {
  const format = formatter(kind);
  const [hover, setHover] = useState<number | null>(null);
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = domainMax ?? Math.max(0.01, ...vals) * 1.15;
  const ts = ticks(max);
  const top = ts[ts.length - 1] ?? max;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const step = innerW / Math.max(1, points.length - 1);
  const x = (i: number) => PAD.l + i * step;
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;

  // Break the line at nulls: missing data is a gap, not zero.
  const segments: string[] = [];
  let current = "";
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current) segments.push(current);
      current = "";
    } else current += `${current ? "L" : "M"}${x(i)},${y(p.value)} `;
  });
  if (current) segments.push(current);
  const hp = hover !== null ? points[hover] : null;

  return (
    <Frame title={title} table={<DataTable points={points} format={format} />}>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}. Use the table view for exact values.`} onMouseLeave={() => setHover(null)}>
          {ts.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {format(t)}
              </text>
            </g>
          ))}
          {segments.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {points.map((p, i) => (
            <rect key={p.label} x={x(i) - step / 2} y={PAD.t} width={step} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
          {hp && hover !== null ? (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + innerH} stroke="var(--panel-border)" />
              {hp.value !== null ? <circle cx={x(hover)} cy={y(hp.value)} r={5} fill={color} stroke="var(--chart-surface)" strokeWidth={2} /> : null}
            </g>
          ) : null}
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--panel-border)" />
          {points.map((p, i) =>
            i % Math.ceil(points.length / 6) === 0 ? (
              <text key={p.label} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                {p.label.slice(5)}
              </text>
            ) : null,
          )}
        </svg>
        {hp ? (
          <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-line bg-panel px-2 py-1 text-xs shadow-sm">
            <div className="text-muted">{hp.label}</div>
            <div className="font-medium text-ink">{hp.value === null ? (hp.note ?? "No data") : format(hp.value)}</div>
          </div>
        ) : null}
      </div>
    </Frame>
  );
}
