/**
 * Provider adapter registry.
 *
 * Reads OAuth client configuration from the environment at call time (no
 * caching), so configuration changes and tests that set env vars take effect
 * immediately. Secrets never leave this module except inside the adapter.
 */
import { createGoogleAdapter } from "@/lib/mailboxes/providers/google";
import { createMicrosoftAdapter } from "@/lib/mailboxes/providers/microsoft";
import type {
  AdapterConfig,
  MailboxProviderAdapter,
  OAuthProvider,
  ScopeExplanation,
} from "@/lib/mailboxes/providers/types";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["google", "microsoft"];

export interface ProviderStatus {
  provider: OAuthProvider;
  displayName: string;
  configured: boolean;
  scopes: readonly string[];
  scopeExplanations: readonly ScopeExplanation[];
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getAdapter(provider: OAuthProvider, overrides: Partial<AdapterConfig> = {}): MailboxProviderAdapter {
  switch (provider) {
    case "google":
      return createGoogleAdapter({
        clientId: env("GOOGLE_CLIENT_ID"),
        clientSecret: env("GOOGLE_CLIENT_SECRET"),
        ...overrides,
      });
    case "microsoft":
      return createMicrosoftAdapter({
        clientId: env("MICROSOFT_CLIENT_ID"),
        clientSecret: env("MICROSOFT_CLIENT_SECRET"),
        tenant: env("MICROSOFT_TENANT"),
        ...overrides,
      });
    default: {
      const unreachable: never = provider;
      throw new Error(`Unsupported provider: ${String(unreachable)}`);
    }
  }
}

/** Connect-screen data for every provider: whether it is configured and what it will ask for. Never includes secrets. */
export function listProviderStatus(): ProviderStatus[] {
  return OAUTH_PROVIDERS.map((provider) => {
    const adapter = getAdapter(provider);
    return {
      provider,
      displayName: adapter.displayName,
      configured: adapter.isConfigured(),
      scopes: adapter.scopes,
      scopeExplanations: adapter.scopeExplanations,
    };
  });
}
