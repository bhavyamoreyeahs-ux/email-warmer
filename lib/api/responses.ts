/**
 * Response envelope — the QuikIT platform contract:
 *   { success: true, data }  |  { success: false, error, code, details? }
 * `error` stays a human-readable string (QuikIT convention); `code` is a stable
 * machine-readable identifier.
 */
import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function ok<T>(data: T, status = 200, headers?: HeadersInit) {
  return NextResponse.json({ success: true, data }, { status, headers });
}

export function created<T>(data: T) {
  return ok(data, 201);
}

export function fail(status: number, code: string, error: string, details?: Record<string, unknown>, headers?: HeadersInit) {
  return NextResponse.json({ success: false, error, code, ...(details ? { details } : {}) }, { status, headers });
}

export function validationError(error: ZodError) {
  return fail(
    400,
    "VALIDATION_FAILED",
    error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "),
    { issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
  );
}
