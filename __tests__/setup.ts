/**
 * Global test setup. Tests never talk to real providers, real DNS or a real
 * mail server: adapters take an injected fetch, the DNS checker takes a fake
 * resolver, and the database is an in-memory PGlite (real PostgreSQL, WASM).
 */
Object.assign(process.env, { NODE_ENV: "test" });
process.env.APP_URL ??= "http://localhost:3020";
process.env.NEXTAUTH_SECRET ??= "test-nextauth-secret-not-for-production-000000";
// 32 zero-ish bytes, base64 — test only.
process.env.TOKEN_ENCRYPTION_KEYS ??= "test1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.RECIPIENT_HASH_KEY ??= "test-recipient-hash-key-000000000000";
process.env.LOG_LEVEL ??= "silent";
