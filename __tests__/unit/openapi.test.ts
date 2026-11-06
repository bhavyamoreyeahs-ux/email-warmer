import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DOCUMENTED_PATHS, openApiDocument } from "@/lib/openapi";

function routeFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full, base);
    return name === "route.ts" ? ["/" + path.relative(base, path.dirname(full)).split(path.sep).join("/")] : [];
  });
}

describe("OpenAPI document", () => {
  const apiDir = path.resolve(__dirname, "../../app/api/v1");
  const routes = routeFiles(apiDir).map((r) => r.replace(/\[([^\]]+)\]/g, "{$1}")).sort();

  it("documents every v1 route file, and nothing that does not exist", () => {
    expect([...DOCUMENTED_PATHS].sort()).toEqual(routes);
  });

  it("is a valid-looking OpenAPI 3.1 document", () => {
    const doc = openApiDocument("http://localhost:3020");
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBe(routes.length);
  });
});
