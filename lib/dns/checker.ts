/**
 * Runs the four email-authentication checks (MX, SPF, DKIM, DMARC) for one
 * domain, concurrently, each inside its own time budget.
 *
 * The MX query is started first and shared: evaluateMx reuses it, and SPF and
 * DKIM read the MX-detected provider from it (briefly — they fall back to the
 * connected mailbox providers alone if MX is slow) to decide which SPF
 * includes and default DKIM selectors to expect. A check that exceeds its
 * budget, or fails unexpectedly, becomes INCONCLUSIVE — never pass or fail.
 */
import { DKIM_RULE_VERSION, defaultSelectorsFor, evaluateDkim } from "@/lib/dns/dkim";
import { DMARC_RULE_VERSION, evaluateDmarc } from "@/lib/dns/dmarc";
import { MX_RULE_VERSION, detectMxProvider, evaluateMx } from "@/lib/dns/mx";
import { SPF_RULE_VERSION, evaluateSpf, expectedSpfIncludesFor } from "@/lib/dns/spf";
import type {
  CheckFinding,
  CheckResult,
  CheckType,
  DkimSelectorInput,
  DnsAnswer,
  DnsResolver,
  DomainCheckOptions,
  MxRecord,
} from "@/lib/dns/types";

export const RULE_VERSIONS = {
  mx: MX_RULE_VERSION,
  spf: SPF_RULE_VERSION,
  dkim: DKIM_RULE_VERSION,
  dmarc: DMARC_RULE_VERSION,
} as const satisfies Record<CheckType, string>;

export const DEFAULT_CHECK_TIMEOUT_MS = 12_000;
/** Longest SPF/DKIM wait for the MX-detected provider before going ahead without it. */
const MAX_PROVIDER_WAIT_MS = 3_000;

type MailboxProvider = NonNullable<DomainCheckOptions["mailboxProviders"]>[number];

const CHECK_NAMES: Record<CheckType, string> = { mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC" };
const SELECTOR_PATTERN = /^[a-z0-9._-]{1,63}$/;

/**
 * Normalises customer DKIM selectors: trims, lowercases, accepts a pasted
 * "<selector>._domainkey.<domain>", validates [a-z0-9._-]{1,63}, dedupes.
 */
export function normalizeDkimSelectors(input: readonly string[]): { valid: string[]; invalid: string[] } {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const raw of input) {
    let selector = raw.trim().toLowerCase();
    const marker = selector.indexOf("._domainkey");
    if (marker > 0) selector = selector.slice(0, marker);
    if (selector === "") continue;
    const wellFormed =
      SELECTOR_PATTERN.test(selector) && !selector.startsWith(".") && !selector.endsWith(".") && !selector.includes("..");
    if (wellFormed) valid.add(selector);
    else invalid.push(raw.trim());
  }
  return { valid: [...valid], invalid };
}

function inconclusiveResult(
  checkType: CheckType,
  domain: string,
  resolver: DnsResolver,
  durationMs: number,
  finding: CheckFinding,
  summary: string,
  parsed?: Record<string, unknown>,
): CheckResult {
  return {
    checkType,
    status: "inconclusive",
    summary,
    findings: [finding],
    evidence: parsed ? { queries: [], parsed } : { queries: [] },
    ruleVersion: RULE_VERSIONS[checkType],
    resolver: resolver.label,
    durationMs,
  };
}

async function withBudget(
  checkType: CheckType,
  domain: string,
  resolver: DnsResolver,
  budgetMs: number,
  task: () => Promise<CheckResult>,
): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const name = CHECK_NAMES[checkType];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        inconclusiveResult(
          checkType,
          domain,
          resolver,
          elapsed(),
          {
            code: `${checkType}_check_timeout`,
            severity: "info",
            message: `The ${name} check did not finish within ${Number((budgetMs / 1000).toFixed(2))} seconds, so its result is unknown.`,
            recommendation: "Run the check again. Slow or unresponsive nameservers (yours or an included provider's) can cause this.",
          },
          `The ${name} check for ${domain} did not finish in time, so its result is unknown.`,
        ),
      );
    }, budgetMs);
  });
  const guarded = Promise.resolve()
    .then(task)
    .catch((error: unknown) =>
      inconclusiveResult(
        checkType,
        domain,
        resolver,
        elapsed(),
        {
          code: `${checkType}_check_error`,
          severity: "info",
          message: `An unexpected error interrupted the ${name} check, so its result is unknown.`,
          recommendation: "Run the check again.",
        },
        `The ${name} check for ${domain} could not be completed, so its result is unknown.`,
        { error: error instanceof Error ? error.message : String(error) },
      ),
    );
  try {
    return await Promise.race([guarded, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves to `promise`'s value, or to `fallback` if it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDomainChecks(
  domain: string,
  resolver: DnsResolver,
  opts: DomainCheckOptions = {},
): Promise<CheckResult[]> {
  const target = domain.trim().toLowerCase().replace(/\.$/, "");
  const budgetMs = Math.max(1, opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
  const mailboxProviders: MailboxProvider[] = [...new Set(opts.mailboxProviders ?? [])];
  const selectors = normalizeDkimSelectors(opts.dkimSelectors ?? []);

  const mxAnswer: Promise<DnsAnswer<MxRecord>> = Promise.resolve()
    .then(() => resolver.mx(target))
    .catch((): DnsAnswer<MxRecord> => ({ outcome: "ERROR", records: [], durationMs: 0 }));
  const allProviders: Promise<MailboxProvider[]> = mxAnswer.then((answer) => {
    const providers = new Set(mailboxProviders);
    const detected = answer.outcome === "NOERROR" ? detectMxProvider(answer.records) : null;
    if (detected === "google" || detected === "microsoft") providers.add(detected);
    return [...providers];
  });
  const providersForChecks = () => within(allProviders, Math.min(MAX_PROVIDER_WAIT_MS, budgetMs / 4), mailboxProviders);

  const results = await Promise.all([
    withBudget("mx", target, resolver, budgetMs, () => evaluateMx(target, resolver, { mxAnswer })),
    withBudget("spf", target, resolver, budgetMs, async () =>
      evaluateSpf(target, resolver, { expectedIncludes: expectedSpfIncludesFor(await providersForChecks()) }),
    ),
    withBudget("dkim", target, resolver, budgetMs, async () => {
      const inputs: DkimSelectorInput[] = [
        ...selectors.valid.map((selector): DkimSelectorInput => ({ selector, source: "customer" })),
        ...defaultSelectorsFor(await providersForChecks()),
      ];
      const result = await evaluateDkim(target, resolver, inputs);
      if (selectors.invalid.length === 0) return result;
      const ignored: CheckFinding = {
        code: "dkim_invalid_selector",
        severity: "info",
        message: `Ignored ${selectors.invalid.map((s) => `"${s}"`).join(", ")}: a selector may contain only letters, digits, dots, hyphens and underscores (up to 63 characters).`,
        recommendation: "Copy the selector exactly from the s= tag of a sent message's DKIM-Signature header.",
      };
      return { ...result, findings: [ignored, ...result.findings] };
    }),
    withBudget("dmarc", target, resolver, budgetMs, () => evaluateDmarc(target, resolver)),
  ]);
  return results;
}
