/**
 * Route-handler test helpers. Tests mock "@/lib/api/session" (the NextAuth
 * seam) and drive the REAL route handlers + withOrgAuth + services + PGlite.
 */
import { vi } from "vitest";
import { NextRequest } from "next/server";
import * as session from "@/lib/api/session";

export function signInAs(userId: string | null, opts: { sessionVersion?: number; selectedOrgId?: string | null } = {}) {
  vi.mocked(session.getSessionIdentity).mockResolvedValue(userId ? { userId, sessionVersion: opts.sessionVersion ?? 0 } : null);
  vi.mocked(session.getSelectedOrgId).mockResolvedValue(opts.selectedOrgId ?? null);
}

export function req(path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.origin !== null) headers.origin = init.origin ?? "http://localhost:3020";
  return new NextRequest(`http://localhost:3020${path}`, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

export async function json(res: Response) {
  return (await res.json()) as { success: boolean; data?: unknown; error?: string; code?: string };
}
