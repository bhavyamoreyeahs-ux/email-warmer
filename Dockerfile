# syntax=docker/dockerfile:1.7
# One image for the web app, the worker and one-off scripts (different commands).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Production-only dependency tree for the runtime image (no test/dev tooling,
# no embedded-postgres binaries). tsx is a runtime dependency for the worker.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN groupadd --system app && useradd --system --gid app --home /app app
# Web: Next.js standalone server + static assets.
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
# Worker, migrations and scripts run with tsx against the production dependency tree.
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/lib ./lib
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --from=build --chown=app:app /app/db ./db
COPY --from=build --chown=app:app /app/tsconfig.json ./tsconfig.json
USER app
EXPOSE 3000 9464
# Web: `node server.js`  ·  Worker: `npx tsx scripts/worker.ts`  ·  Migrate: `npx tsx scripts/migrate.ts`
CMD ["node", "server.js"]
