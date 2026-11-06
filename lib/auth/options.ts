/**
 * NextAuth configuration — mirrors the QuikIT pattern (quikims/lib/auth.ts):
 *
 *  - QuikIT SSO mode: when QUIKIT_URL (or QUIKIT_ISSUER_URL), QUIKIT_CLIENT_ID
 *    and QUIKIT_CLIENT_SECRET are set, users authenticate through the QuikIT
 *    identity provider via OpenID Connect. The exact QuikIT IdP contract
 *    (`@quikit/auth`) was not available to this standalone build; the provider
 *    below assumes standard OIDC discovery and MUST be confirmed by the QuikIT
 *    integration owner (docs/launch-dependencies.md).
 *  - Credentials mode (standalone / local): email + password, bcrypt.
 *
 * Sessions are JWTs (NextAuth v4 requirement for credentials), so the JWT is
 * treated only as proof of identity: every protected request re-reads the user
 * and membership from the database (lib/api/principal.ts), which is how a
 * disabled user or a revoked session (`sessionVersion` bump) loses access
 * immediately rather than at token expiry.
 */
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { DUMMY_HASH, verifyPassword } from "@/lib/auth/password";
import { checkRateLimit } from "@/lib/ratelimit";
import { recordAudit } from "@/lib/audit";
import { sha256Hex } from "@/lib/crypto/hash";

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

async function authorizeCredentials(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  // Per-account limit stops online guessing against one account; the per-IP
  // limit in middleware-free form lives on the signup route.
  const limit = await checkRateLimit(`login:${sha256Hex(normalized)}`, 10, 15 * 60);
  if (!limit.allowed) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !valid || user.status !== "active") {
    await recordAudit({
      orgId: null,
      actor: { type: "user", userId: user?.id ?? null, label: normalized },
      action: "auth.login",
      targetType: "user",
      targetId: user?.id ?? null,
      outcome: "denied",
      reason: user && user.status !== "active" ? "account disabled" : "invalid credentials",
    });
    return null;
  }
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await recordAudit({ orgId: null, actor: { type: "user", userId: user.id, label: normalized }, action: "auth.login", targetType: "user", targetId: user.id, outcome: "success" });
  return { id: user.id, email: user.email, name: user.name, sv: user.sessionVersion };
}

function quikitProvider() {
  const e = env();
  const issuer = (e.QUIKIT_ISSUER_URL ?? e.QUIKIT_URL)!.replace(/\/$/, "");
  return {
    id: "quikit",
    name: "QuikIT",
    type: "oauth" as const,
    wellKnown: `${issuer}/.well-known/openid-configuration`,
    clientId: e.QUIKIT_CLIENT_ID,
    clientSecret: e.QUIKIT_CLIENT_SECRET,
    authorization: { params: { scope: "openid email profile" } },
    idToken: true,
    checks: ["pkce", "state"] as ("pkce" | "state")[],
    profile(profile: { sub: string; email: string; name?: string }) {
      return { id: profile.sub, email: profile.email, name: profile.name ?? profile.email };
    },
  };
}

/** Just-in-time provisioning for SSO users, keyed by the IdP subject. */
async function upsertSsoUser(subject: string, email: string, name: string, emailVerified: boolean) {
  const normalized = email.trim().toLowerCase();
  const [existing] = await db.select().from(users).where(eq(users.externalSubject, subject)).limit(1);
  if (existing) {
    if (existing.status !== "active") return null;
    await db.update(users).set({ lastLoginAt: new Date(), email: normalized }).where(eq(users.id, existing.id));
    return existing;
  }
  const [byEmail] = await db.select().from(users).where(and(sql`lower(${users.email}) = ${normalized}`)).limit(1);
  if (byEmail) {
    // Never attach an IdP identity to an existing account on an unverified email claim.
    if (!emailVerified) return null;
    if (byEmail.status !== "active") return null;
    await db.update(users).set({ externalSubject: subject, lastLoginAt: new Date() }).where(eq(users.id, byEmail.id));
    return byEmail;
  }
  const [created] = await db.insert(users).values({ email: normalized, name, externalSubject: subject, lastLoginAt: new Date() }).returning();
  return created ?? null;
}

export function buildAuthOptions(): NextAuthOptions {
  const e = env();
  const sso = e.authMode === "quikit_sso";
  return {
    secret: e.NEXTAUTH_SECRET ?? (e.NODE_ENV === "production" ? undefined : "dev-only-insecure-nextauth-secret-change-me"),
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    pages: { signIn: "/login", error: "/login" },
    // Secure, HttpOnly, SameSite=Lax cookies; NextAuth adds the __Secure- prefix
    // automatically when NEXTAUTH_URL / APP_URL is https.
    useSecureCookies: e.APP_URL.startsWith("https://"),
    providers: sso
      ? [quikitProvider()]
      : [
          CredentialsProvider({
            name: "Email and password",
            credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
            async authorize(credentials) {
              if (!credentials?.email || !credentials.password) return null;
              return authorizeCredentials(credentials.email, credentials.password);
            },
          }),
        ],
    callbacks: {
      async signIn({ user, account, profile }) {
        if (account?.provider !== "quikit") return true;
        const p = profile as { sub?: string; email?: string; name?: string; email_verified?: boolean } | undefined;
        if (!p?.sub || !p.email) return false;
        const local = await upsertSsoUser(p.sub, p.email, p.name ?? p.email, p.email_verified === true);
        if (!local) return false;
        (user as { localId?: string; sv?: number }).localId = local.id;
        (user as { localId?: string; sv?: number }).sv = local.sessionVersion;
        return true;
      },
      async jwt({ token, user }) {
        if (user) {
          const u = user as { id: string; localId?: string; sv?: number };
          token.uid = u.localId ?? u.id;
          token.sv = u.sv ?? 0;
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user) {
          (session.user as { id?: string; sv?: number }).id = token.uid as string;
          (session.user as { id?: string; sv?: number }).sv = (token.sv as number) ?? 0;
        }
        return session;
      },
    },
  };
}

let cachedOptions: NextAuthOptions | null = null;
export function authOptions(): NextAuthOptions {
  if (!cachedOptions || process.env.NODE_ENV === "test") cachedOptions = buildAuthOptions();
  return cachedOptions;
}
