/**
 * A small Prometheus-compatible metrics registry (text exposition format 0.0.4): counters, gauges and histograms with labels.
 * No dependency on purpose: the node needs about a dozen metrics, and a metrics library is a lot of surface for that.
 */
export type Labels = Record<string, string>;

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k])}"`)
    .join(",");

export function escapeLabel(v: string): string {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

const num = (n: number): string => (Number.isFinite(n) ? String(n) : n > 0 ? "+Inf" : n < 0 ? "-Inf" : "NaN");
const line = (name: string, key: string, value: number): string => `${name}${key ? `{${key}}` : ""} ${num(value)}`;

abstract class Metric {
  constructor(readonly name: string, readonly help: string, readonly type: "counter" | "gauge" | "histogram") {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`invalid metric name ${name}`);
  }
  abstract lines(): string[];
  header(): string[] {
    return [`# HELP ${this.name} ${this.help.replace(/\n/g, " ")}`, `# TYPE ${this.name} ${this.type}`];
  }
}

export class Counter extends Metric {
  private values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, "counter");
  }
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error("a counter cannot decrease");
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
  lines(): string[] {
    return [...this.values].map(([k, v]) => line(this.name, k, v));
  }
}

export class Gauge extends Metric {
  private values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, "gauge");
  }
  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }
  get(labels: Labels = {}): number | undefined {
    return this.values.get(labelKey(labels));
  }
  /** Forget every series (used before re-setting a labelled gauge, so a vanished label does not linger). */
  reset(): void {
    this.values.clear();
  }
  lines(): string[] {
    return [...this.values].map(([k, v]) => line(this.name, k, v));
  }
}

export class Histogram extends Metric {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, readonly buckets: number[] = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20]) {
    super(name, help, "histogram");
  }
  observe(value: number, labels: Labels = {}): void {
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }));
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]++;
    });
    s.sum += value;
    s.count++;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : "";
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(line(`${this.name}_sum`, k, s.sum));
      out.push(line(`${this.name}_count`, k, s.count));
    }
    return out;
  }
}

export class Registry {
  private all: Metric[] = [];
  private collectors: (() => void | Promise<void>)[] = [];
  counter(name: string, help: string): Counter {
    return this.add(new Counter(name, help));
  }
  gauge(name: string, help: string): Gauge {
    return this.add(new Gauge(name, help));
  }
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    return this.add(new Histogram(name, help, buckets));
  }
  private add<T extends Metric>(m: T): T {
    if (this.all.some((x) => x.name === m.name)) throw new Error(`metric ${m.name} is registered twice`);
    this.all.push(m);
    return m;
  }
  /** A function run before every scrape that refreshes gauges (e.g. reads the relayer balance). A failing collector is skipped. */
  onCollect(fn: () => void | Promise<void>): void {
    this.collectors.push(fn);
  }
  async render(): Promise<string> {
    await Promise.all(this.collectors.map(async (c) => { try { await c(); } catch { /* one broken collector must not blind the rest */ } }));
    return (
      this.all
        .flatMap((m) => {
          const l = m.lines();
          return l.length ? [...m.header(), ...l] : [];
        })
        .join("\n") + "\n"
    );
  }
}
