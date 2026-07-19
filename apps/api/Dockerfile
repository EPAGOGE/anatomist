# Multi-stage build for the EPAGOGE Fastify API.
#
# Stage 1 (deps): install every workspace package; the monorepo's TS
# project references mean the api can't be typechecked or built without
# its dependent packages built first.
# Stage 2 (build): tsc --build across the workspace, producing dist/
# in every package + apps/api.
# Stage 3 (runtime): minimal Node image with only the production node
# modules and built dist/ artifacts.
#
# Build context: the monorepo root (so workspace package.jsons + source
# are all visible). Build invocation:
#   docker build -f apps/api/Dockerfile -t epagoge-api .

# ---------- Stage 1: dependency install ----------
FROM node:24-alpine AS deps
WORKDIR /repo

# Build essentials for native modules (argon2, @oqs/liboqs-js, etc.).
RUN apk add --no-cache python3 make g++ libc6-compat

# Copy root package files + every workspace's package.json so
# npm install can resolve workspace links without copying source first
# (better layer cache: source changes don't bust the install layer).
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/inference/package.json ./packages/inference/
COPY packages/ledger/package.json ./packages/ledger/
COPY packages/ai/package.json ./packages/ai/
COPY packages/components/package.json ./packages/components/
COPY packages/codegen/package.json ./packages/codegen/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# `npm ci` is reproducible and refuses to update package-lock — appropriate
# for CI/release builds. --include=dev because we need TypeScript + the build
# toolchain to produce dist/; the production stage discards dev deps.
RUN npm ci --include=dev

# ---------- Stage 2: workspace build ----------
FROM deps AS build
WORKDIR /repo

# Copy all source files. The exclusions in .dockerignore (node_modules,
# dist/, coverage/, .env, etc.) keep this layer tight.
COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json tsconfig.json ./

# TS project-reference build: walks the reference graph, builds every
# package the api depends on, then builds the api itself. This is the
# same build the local typecheck script uses.
RUN npm run -w @epagoge/api build

# Prune to production-only deps for the final stage (saves ~150MB+ on a
# typical monorepo). npm prune removes devDependencies in place.
RUN npm prune --omit=dev

# ---------- Stage 3: runtime ----------
FROM node:24-alpine AS runtime
WORKDIR /app

# Non-root user. The numeric UID matches Alpine's `node` user (1000:1000)
# which lets the user inside the container be mapped to host UIDs cleanly
# when volumes are bind-mounted (uncommon in cloud but cheap to set up).
ENV NODE_ENV=production
USER node

# Copy production dependencies + built dist. The package-tree includes
# workspace symlinks under node_modules/@epagoge/*; the COPY preserves
# symlinks by default when source is a directory.
COPY --chown=node:node --from=build /repo/node_modules ./node_modules
COPY --chown=node:node --from=build /repo/packages ./packages
COPY --chown=node:node --from=build /repo/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=build /repo/apps/api/package.json ./apps/api/
COPY --chown=node:node --from=build /repo/apps/api/drizzle ./apps/api/drizzle
COPY --chown=node:node --from=build /repo/package.json ./

# Health checks: Fastify exposes /health/live (process up) and /health/ready
# (dependencies reachable). The cloud orchestrator (ECS/Cloud Run/etc.) does
# the real probing; this Dockerfile HEALTHCHECK is a fallback for plain Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 3000

# Entry: the API server with graceful SIGTERM handling already in src/index.ts.
# Migration runs separately (see docs/DEPLOYMENT.md) — NEVER in the app's
# entrypoint, because:
#  - multi-instance deploys would race on migration
#  - migration failure should be a deploy-time signal, not a runtime crash
CMD ["node", "apps/api/dist/index.js"]
