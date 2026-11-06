/**
 * Domain-name normalisation for user input.
 *
 * Users paste all sorts of things into a "domain" field: URLs, email
 * addresses, mixed case, trailing dots, Unicode names. normalizeDomain turns
 * that into a canonical lowercase A-label (ASCII) domain, or a plain-language
 * error. It only accepts names that can carry public email DNS records: no IP
 * literals, no single-label or special-use names, and no bare public suffixes
 * such as "co.uk" (the Public Suffix List via tldts decides).
 */
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { getDomain, parse } from "tldts";

export type NormalizeDomainResult = { ok: true; domain: string } | { ok: false; error: string };

const MAX_DOMAIN_LENGTH = 253;
/** LDH label: letters, digits, hyphens; 1–63 chars; no leading/trailing hyphen. */
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Special-use names that can never carry public DNS (RFC 6761, RFC 7686, RFC 8375). */
const NON_PUBLIC_TLDS = new Set(["localhost", "local", "invalid", "onion", "internal"]);

function fail(error: string): NormalizeDomainResult {
  return { ok: false, error };
}

export function normalizeDomain(input: string): NormalizeDomainResult {
  let value = input.trim().toLowerCase();
  if (value === "") return fail("Enter a domain name, for example example.com.");

  // Pasted URL or mailto: strip the scheme, then anything after the host.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(value);
  if (scheme) value = value.slice(scheme[0].length);
  else if (value.startsWith("mailto:")) value = value.slice("mailto:".length);
  value = value.split(/[/?#]/, 1)[0] ?? "";

  // Pasted email address (or user:pass@host): keep the part after the last "@".
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1);

  if (value.startsWith("[")) return fail("IP addresses are not supported. Enter a domain name instead.");
  value = value.replace(/:\d*$/, ""); // port
  if (value.includes(":")) return fail("IP addresses are not supported. Enter a domain name instead.");
  if (value.endsWith(".")) value = value.slice(0, -1);

  if (value === "") return fail("Enter a domain name, for example example.com.");
  if (/\s/.test(value)) return fail("A domain name cannot contain spaces.");
  if (isIP(value) !== 0) return fail("IP addresses are not supported. Enter a domain name instead.");

  // IDNA (UTS #46) → A-labels. Returns "" for names it cannot convert.
  const ascii = domainToASCII(value);
  if (ascii === "") return fail(`"${input.trim()}" is not a valid domain name.`);
  // The WHATWG host parser turns numeric-looking names (e.g. "1.2.3", "0x7f.1") into IPv4.
  if (isIP(ascii) !== 0) return fail("IP addresses are not supported. Enter a domain name instead.");

  if (ascii.length > MAX_DOMAIN_LENGTH) return fail("That domain name is too long (maximum 253 characters).");
  const labels = ascii.split(".");
  if (labels.length < 2) return fail("Enter a full domain name with at least two parts, for example example.com.");
  for (const label of labels) {
    if (label === "") return fail(`"${input.trim()}" contains an empty label (two dots in a row).`);
    if (label.length > 63) return fail("Each part of a domain name must be 63 characters or fewer.");
    if (!LDH_LABEL.test(label)) {
      return fail(
        `"${label}" is not a valid domain label: use letters, digits and hyphens only, not starting or ending with a hyphen.`,
      );
    }
  }

  const tld = labels[labels.length - 1] ?? "";
  if (NON_PUBLIC_TLDS.has(tld) || ascii === "localhost") {
    return fail(`${ascii} is a local or special-use name, not a public domain.`);
  }
  if (ascii.endsWith(".home.arpa")) return fail(`${ascii} is a home-network name, not a public domain.`);

  const parsed = parse(ascii);
  if (parsed.isIp) return fail("IP addresses are not supported. Enter a domain name instead.");
  // A bare public suffix ("co.uk", "com") has no registrable domain.
  if (parsed.domain === null) {
    return fail(`${ascii} is a public suffix, not a domain you can own. Enter your domain, for example example.${ascii}.`);
  }

  return { ok: true, domain: ascii };
}

/**
 * The organizational domain (registrable domain per the ICANN section of the
 * Public Suffix List), used for DMARC policy discovery and report-destination
 * comparisons. Returns null when there is none (e.g. a bare public suffix).
 */
export function organizationalDomain(domain: string): string | null {
  return getDomain(domain.toLowerCase().replace(/\.$/, "")) ?? null;
}
