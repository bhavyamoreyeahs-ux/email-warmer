/**
 * Structured JSON logger with secret redaction.
 *
 * Rules: never log tokens, secrets, passwords, cookies, authorization headers,
 * OAuth codes, email subjects or bodies. Keys matching REDACT_KEYS are replaced
 * wherever they appear (nested included), and string values that look like
 * bearer tokens / JWTs are masked as a second line of defence.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Exact sensitive keys, plus anything ending in token/secret/password. Deliberately
// does not match look-alikes such as `subjectType` or `inputTokens`.
const REDACT_KEYS =
  /^(authorization|cookie|set-cookie|api[_-]?key|code|code[_-]?verifier|subject|body|signature|private[_-]?key|refresh)$|(token|secret|password|passwd)$/i;
const TOKENISH = /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|ya29\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,})/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.replace(TOKENISH, "[redacted]");
  if (value instanceof Error) {
    return { name: value.name, message: String(redact(value.message, depth + 1)) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? "info") as Level | "silent";
  return ORDER[lvl] ?? ORDER.info;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    service: process.env.QUIKREACH_SERVICE ?? "quikreach-web",
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

function make(bound: Record<string, unknown>): Logger {
  return {
    debug: (m, f) => emit("debug", m, { ...bound, ...f }),
    info: (m, f) => emit("info", m, { ...bound, ...f }),
    warn: (m, f) => emit("warn", m, { ...bound, ...f }),
    error: (m, f) => emit("error", m, { ...bound, ...f }),
    child: (more) => make({ ...bound, ...more }),
  };
}

export const logger: Logger = make({});

/**
 * Error-reporting hook. Logs today; wire an error tracker (e.g. Sentry) here —
 * it is the single place unexpected exceptions flow through. Scrubbed via
 * `redact` before leaving the process.
 */
export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  logger.error("unhandled_error", {
    ...context,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack?.split("\n").slice(0, 6).join("\n") } : String(error),
  });
}
