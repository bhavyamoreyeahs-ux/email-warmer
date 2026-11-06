/**
 * Production DnsResolver backed by node:dns (c-ares).
 *
 * Contract (see lib/dns/types.ts): methods never throw. Every failure is
 * mapped to a DnsOutcome so callers can turn timeouts into INCONCLUSIVE
 * results. Each query is additionally capped by a hard Promise.race timeout,
 * because c-ares retries/backoff across several servers can otherwise run
 * well past the configured per-try timeout.
 */
import { promises as dnsPromises } from "node:dns";
import type { DnsAnswer, DnsOutcome, DnsResolver, MxRecord } from "@/lib/dns/types";

export interface NodeResolverOptions {
  /** Upstream servers (IPs, optionally with port). Omit to use the system resolver configuration. */
  servers?: string[];
  /** Hard upper bound for a single query, ms. */
  timeoutMs?: number;
}

export const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

const TIMED_OUT: unique symbol = Symbol("dns-timeout");

/** Maps a node:dns error to a DnsOutcome. Unknown errors become "ERROR". */
export function mapDnsError(error: unknown): DnsOutcome {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  switch (code) {
    case "ENOTFOUND":
      return "NXDOMAIN";
    case "ENODATA":
      return "NODATA";
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return "TIMEOUT";
    case "ESERVFAIL":
      return "SERVFAIL";
    case "EREFUSED":
      return "REFUSED";
    default:
      return "ERROR";
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Creates a resolver. Throws only on invalid configuration (bad server
 * addresses), never at query time.
 */
export function createNodeResolver(opts: NodeResolverOptions = {}): DnsResolver {
  const timeoutMs = Math.max(100, opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
  // c-ares grows the per-try timeout on retry (roughly t, then 2t), so with
  // tries: 2 a per-try timeout of ~timeoutMs/3 keeps both tries inside the hard cap.
  const resolver = new dnsPromises.Resolver({ timeout: Math.max(100, Math.floor(timeoutMs / 3)), tries: 2 });
  const servers = (opts.servers ?? []).map((s) => s.trim()).filter((s) => s !== "");
  if (servers.length > 0) resolver.setServers(servers);
  const label = servers.length > 0 ? servers.join(",") : "system";

  async function run<T>(query: () => Promise<T[]>): Promise<DnsAnswer<T>> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      // If the deadline wins, the losing query's eventual rejection is still
      // handled by Promise.race, so it cannot become an unhandled rejection.
      const result = await Promise.race([query(), deadline]);
      if (result === TIMED_OUT) return { outcome: "TIMEOUT", records: [], durationMs: elapsed() };
      if (result.length === 0) return { outcome: "NODATA", records: [], durationMs: elapsed() };
      return { outcome: "NOERROR", records: result, durationMs: elapsed() };
    } catch (error: unknown) {
      return { outcome: mapDnsError(error), records: [], durationMs: elapsed() };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    label,
    txt: (name) =>
      run(async () => (await resolver.resolveTxt(normalizeName(name))).map((chunks) => chunks.join(""))),
    mx: (name) =>
      run(async (): Promise<MxRecord[]> =>
        (await resolver.resolveMx(normalizeName(name))).map((r) => ({
          exchange: normalizeName(r.exchange),
          priority: r.priority,
        })),
      ),
    a: (name) => run(() => resolver.resolve4(normalizeName(name))),
    aaaa: (name) => run(() => resolver.resolve6(normalizeName(name))),
  };
}
