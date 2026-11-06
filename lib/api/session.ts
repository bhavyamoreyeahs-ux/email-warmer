/**
 * Thin seam over NextAuth + cookies so authorization logic can be unit-tested
 * without a running Next.js request (tests mock this module).
 */
import { getServerSession } from "next-auth";
import { cookies, headers } from "next/headers";
import { authOptions } from "@/lib/auth/options";

/** Cookie holding the user's SELECTED organisation. A preference, never an authorization. */
export const ORG_COOKIE = "qr_org";

export interface SessionIdentity {
  userId: string;
  sessionVersion: number;
}

export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const session = await getServerSession(authOptions());
  const user = session?.user as { id?: string; sv?: number } | undefined;
  if (!user?.id) return null;
  return { userId: user.id, sessionVersion: user.sv ?? 0 };
}

export async function getSelectedOrgId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(ORG_COOKIE)?.value ?? null;
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export async function getClientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}
