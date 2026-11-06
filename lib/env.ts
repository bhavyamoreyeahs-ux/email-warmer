/**
 * Validated runtime configuration.
 *
 * Read lazily (on first use, not at import time) so that `next build`, tests and
 * scripts can import modules without a full production environment, while a
 * misconfigured production deployment still fails loudly the first time a
 * value is needed. Every variable is documented in .env.example.
 */
import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(min).max(max));

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3020"),
  DATABASE_URL: optional,
  DATABASE_POOL_MAX: int(10, 1, 100),
  DATABASE_SSL: bool(false),

  NEXTAUTH_SECRET: optional,
  QUIKIT_URL: optional,
  QUIKIT_ISSUER_URL: optional,
  QUIKIT_CLIENT_ID: optional,
  QUIKIT_CLIENT_SECRET: optional,
  ALLOW_SELF_SIGNUP: optional,

  TOKEN_ENCRYPTION_KEYS: optional,
  RECIPIENT_HASH_KEY: optional,

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  MICROSOFT_CLIENT_ID: optional,
  MICROSOFT_CLIENT_SECRET: optional,
  MICROSOFT_TENANT: z.string().default("organizations"),

  DNS_RESOLVERS: optional,
  DNS_TIMEOUT_MS: int(4000, 500, 30000),

  AI_PROVIDER: z.enum(["anthropic", "none"]).default("none"),
  ANTHROPIC_API_KEY: optional,
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_TIMEOUT_MS: int(60000, 5000, 300000),

  SMTP_URL: optional,
  EMAIL_FROM: optional,

  DEFAULT_EVENT_RETENTION_DAYS: int(90, 1, 3650),
  DEFAULT_DIAGNOSTIC_RETENTION_DAYS: int(90, 1, 3650),
  DEFAULT_AUDIT_RETENTION_DAYS: int(365, 30, 3650),

  SYNC_INTERVAL_MINUTES: int(15, 5, 1440),
  SCAN_INTERVAL_HOURS: int(24, 1, 720),
  SYNC_MAX_MESSAGES: int(500, 10, 5000),
  INITIAL_SYNC_DAYS: int(14, 1, 90),

  WORKER_CONCURRENCY: int(4, 1, 32),
  WORKER_POLL_MS: int(2000, 250, 60000),
  WORKER_HEALTH_PORT: int(9464, 0, 65535),
  METRICS_TOKEN: optional,

  ALLOW_PRIVATE_WEBHOOK_TARGETS: bool(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type Env = z.infer<typeof schema> & {
  authMode: "quikit_sso" | "credentials";
  selfSignupAllowed: boolean;
};

let cached: Env | null = null;

export function env(): Env {
  if (cached && process.env.NODE_ENV !== "test") return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const quikitUrl = e.QUIKIT_URL ?? e.QUIKIT_ISSUER_URL;
  const authMode = quikitUrl && e.QUIKIT_CLIENT_ID && e.QUIKIT_CLIENT_SECRET ? "quikit_sso" : "credentials";
  const selfSignupAllowed =
    e.ALLOW_SELF_SIGNUP !== undefined ? ["1", "true", "yes", "on"].includes(e.ALLOW_SELF_SIGNUP.toLowerCase()) : e.NODE_ENV !== "production";

  if (e.NODE_ENV === "production") {
    const missing = (["DATABASE_URL", "NEXTAUTH_SECRET", "TOKEN_ENCRYPTION_KEYS", "RECIPIENT_HASH_KEY"] as const).filter((k) => !e[k]);
    if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
    if (!e.APP_URL.startsWith("https://")) throw new Error("APP_URL must use https:// in production");
    if (e.ALLOW_PRIVATE_WEBHOOK_TARGETS) throw new Error("ALLOW_PRIVATE_WEBHOOK_TARGETS must not be enabled in production");
  }

  cached = { ...e, authMode, selfSignupAllowed };
  return cached;
}

export function isProduction(): boolean {
  return env().NODE_ENV === "production";
}
