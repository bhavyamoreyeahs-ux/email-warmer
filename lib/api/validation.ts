import type { NextRequest } from "next/server";
import type { z } from "zod";
import { readJson } from "@/lib/api/with-org-auth";

/** Parse + validate a JSON body. ZodError is mapped to 400 by the guard. */
export async function parseBody<S extends z.ZodTypeAny>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  return schema.parse(await readJson(req));
}

