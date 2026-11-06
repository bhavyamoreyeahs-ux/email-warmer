/**
 * Minimal in-process metrics registry exposed in Prometheus text format.
 *
 * Each process (web, worker) keeps its own counters; scrape both. Labels must be
 * low-cardinality — never put org ids, emails or domains in labels.
 */
type Labels = Record<string, string>;

const counters = new Map<string, Map<string, number>>();
const gauges = new Map<string, Map<string, number>>();
const help = new Map<string, string>();

const key = (labels: Labels = {}) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
    .join(",");

export function incCounter(name: string, labels?: Labels, by = 1, description?: string): void {
  if (description) help.set(name, description);
  const series = counters.get(name) ?? new Map<string, number>();
  const k = key(labels);
  series.set(k, (series.get(k) ?? 0) + by);
  counters.set(name, series);
}

export function setGauge(name: string, value: number, labels?: Labels, description?: string): void {
  if (description) help.set(name, description);
  const series = gauges.get(name) ?? new Map<string, number>();
  series.set(key(labels), value);
  gauges.set(name, series);
}

export function renderMetrics(): string {
  const lines: string[] = [];
  const render = (kind: "counter" | "gauge", map: Map<string, Map<string, number>>) => {
    for (const [name, series] of map) {
      if (help.has(name)) lines.push(`# HELP ${name} ${help.get(name)}`);
      lines.push(`# TYPE ${name} ${kind}`);
      for (const [labels, value] of series) lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
    }
  };
  render("counter", counters);
  render("gauge", gauges);
  return lines.join("\n") + "\n";
}
