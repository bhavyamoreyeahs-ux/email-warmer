"use client";

/** Same-origin JSON client for mutations. Returns the envelope; never throws for HTTP errors. */
export type ApiResult<T> = { success: true; data: T } | { success: false; error: string; code: string; details?: Record<string, unknown> };

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 204) return { success: true, data: undefined as T };
    const json = (await res.json().catch(() => null)) as ApiResult<T> | null;
    if (!json) return { success: false, error: `Unexpected response (HTTP ${res.status}).`, code: "BAD_RESPONSE" };
    return json;
  } catch {
    return { success: false, error: "Network error — check your connection and try again.", code: "NETWORK" };
  }
}
