import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api/errors";

/** Server components: map a service-layer 404 (including other tenants' ids) to the Next.js not-found page. */
export async function orNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}

/** Accept only UUID-shaped route ids before hitting the database. */
export function assertUuid(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  return id;
}
