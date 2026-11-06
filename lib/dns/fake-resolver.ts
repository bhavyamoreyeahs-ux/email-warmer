/**
 * In-memory DnsResolver for tests (and demo data). No network access.
 *
 * Built from a zone map keyed "name|TYPE":
 *   new FakeResolver({
 *     "example.com|TXT": ["v=spf1 -all"],
 *     "example.com|MX": [{ exchange: "mx.example.com", priority: 10 }],
 *     "_dmarc.example.com|TXT": "TIMEOUT",
 *   })
 * A value is either the records to return (NOERROR; an empty array means
 * NODATA) or a DnsOutcome to simulate a failure. Unknown keys → NXDOMAIN.
 */
import type { DnsAnswer, DnsOutcome, DnsResolver, MxRecord } from "@/lib/dns/types";

export interface FakeZone {
  [key: `${string}|TXT`]: string[] | DnsOutcome;
  [key: `${string}|MX`]: MxRecord[] | DnsOutcome;
  [key: `${string}|A`]: string[] | DnsOutcome;
  [key: `${string}|AAAA`]: string[] | DnsOutcome;
}

export interface FakeResolverOptions {
  /** Artificial latency per "name|TYPE" key, ms — e.g. to exercise check budgets. */
  delays?: Record<string, number>;
}

type FakeType = "TXT" | "MX" | "A" | "AAAA";
type FakeValue = string[] | MxRecord[] | DnsOutcome;

function keyFor(name: string, type: string): string {
  return `${name.trim().toLowerCase().replace(/\.$/, "")}|${type.toUpperCase()}`;
}

function normalizeKey(key: string): string {
  const bar = key.lastIndexOf("|");
  return bar === -1 ? key : keyFor(key.slice(0, bar), key.slice(bar + 1));
}

export class FakeResolver implements DnsResolver {
  readonly label = "fake";
  /** Every query in call order, as "name|TYPE". */
  readonly queryLog: string[] = [];
  private readonly zone = new Map<string, FakeValue>();
  private readonly delays = new Map<string, number>();

  constructor(zone: FakeZone = {}, options: FakeResolverOptions = {}) {
    for (const [key, value] of Object.entries(zone) as Array<[string, FakeValue]>) {
      this.zone.set(normalizeKey(key), value);
    }
    for (const [key, ms] of Object.entries(options.delays ?? {})) this.delays.set(normalizeKey(key), ms);
  }

  get queryCount(): number {
    return this.queryLog.length;
  }

  /** Number of queries made for one "name|TYPE" key. */
  countFor(key: string): number {
    const wanted = normalizeKey(key);
    return this.queryLog.filter((k) => k === wanted).length;
  }

  txt(name: string): Promise<DnsAnswer<string>> {
    return this.answer<string>(name, "TXT");
  }

  mx(name: string): Promise<DnsAnswer<MxRecord>> {
    return this.answer<MxRecord>(name, "MX");
  }

  a(name: string): Promise<DnsAnswer<string>> {
    return this.answer<string>(name, "A");
  }

  aaaa(name: string): Promise<DnsAnswer<string>> {
    return this.answer<string>(name, "AAAA");
  }

  private async answer<T>(name: string, type: FakeType): Promise<DnsAnswer<T>> {
    const key = keyFor(name, type);
    this.queryLog.push(key);
    const delay = this.delays.get(key) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const value = this.zone.get(key);
    if (value === undefined) return { outcome: "NXDOMAIN", records: [], durationMs: delay };
    if (typeof value === "string") return { outcome: value, records: [], durationMs: delay };
    if (value.length === 0) return { outcome: "NODATA", records: [], durationMs: delay };
    // The zone map's template-literal keys tie each value shape to its record type.
    return { outcome: "NOERROR", records: [...value] as unknown as T[], durationMs: delay };
  }
}
