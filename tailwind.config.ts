import type { Config } from "tailwindcss";

/**
 * QuikReach Tailwind config.
 *
 * Colour follows the QuikIT design system: near-monochrome surfaces driven by
 * CSS custom properties (see app/globals.css), a dark navigation rail, and
 * `accent-*` for branded interactive elements only. Semantic states
 * (pass / warn / fail / unknown) use fixed hues and are ALWAYS paired with a
 * text label and icon — colour is never the only signal.
 *
 * TODO(integration): replace with `@quikit/ui/tailwind-config` when this app
 * moves into the QuikIT monorepo.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Gilroy", "Helvetica Neue", "Arial", "system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        canvas: "var(--bg)",
        panel: "var(--panel-bg)",
        line: "var(--panel-border)",
        ink: "var(--text-primary)",
        muted: "var(--text-muted)",
        rail: "var(--rail-bg)",
        accent: {
          50: "var(--accent-50)",
          100: "var(--accent-100)",
          500: "var(--accent-500)",
          600: "var(--accent-600)",
          700: "var(--accent-700)",
        },
      },
      letterSpacing: { tightest: "-0.03em", tighter: "-0.015em" },
    },
  },
  plugins: [],
};

export default config;
