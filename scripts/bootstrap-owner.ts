/**
 * Create a workspace and a one-time Owner invitation link (invite-only deployments):
 *   npm run bootstrap:owner -- --org "Acme Outbound" --email owner@acme.com
 * Run with production DATABASE_URL and APP_URL in the environment. The link is
 * printed once, works once, and expires after 7 days.
 */
import { bootstrapOrganization } from "@/lib/tenancy/bootstrap";
import { closeDb } from "@/lib/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg("org");
  const email = arg("email");
  if (!name || !email) throw new Error('Usage: npm run bootstrap:owner -- --org "Name" --email owner@example.com');
  const r = await bootstrapOrganization({ name, ownerEmail: email });
  console.log(`[bootstrap-owner] workspace "${r.orgName}" created.`);
  console.log(`  one-time owner invitation for ${email} (expires ${r.expiresAt.toISOString()}):`);
  console.log(`  ${r.acceptUrl}`);
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error("[bootstrap-owner] failed:", error instanceof Error ? error.message : error);
    await closeDb();
    process.exit(1);
  });
