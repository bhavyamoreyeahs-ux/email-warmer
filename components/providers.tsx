"use client";

/**
 * Client providers. QuikIT fixes the order SessionProvider → QueryClientProvider
 * → ThemeProvider; QuikReach only needs the session provider today.
 */
import { SessionProvider } from "next-auth/react";

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
