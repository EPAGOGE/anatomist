# Multi-stage build for the EPAGOGE web app (React + Vite → static bundle).
#
# Stage 1 (build): npm install + vite build → dist/ static bundle.
# Stage 2 (runtime): nginx serving the static bundle with SPA fallback +
# sensible defaults (gzip, no cache on index.html, immutable cache on
# /assets/*).
#
# Build context: the monorepo root (workspace deps live under packages/).
# Build invocation:
#   docker build -f apps/web/Dockerfile -t epagoge-web .
#
# Production env: configure the API base URL at BUILD TIME via
#   --build-arg VITE_API_BASE_URL=https://api.your-domain
# Vite inlines build-time env vars; runtime env injection isn't supported
# without an additional template-render step. See docs/DEPLOYMENT.md for
# the rebuild-on-API-URL-change workflow.

# ---------- Stage 1: build ----------
FROM node:24-alpine AS build
WORKDIR /repo

RUN apk add --no-cache python3 make g++ libc6-compat

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

RUN npm ci --include=dev

COPY packages ./packages
COPY apps/web ./apps/web

# Vite build-time env. Override at build time:
#   docker build --build-arg VITE_API_BASE_URL=https://api.epagoge.example -f apps/web/Dockerfile .
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run -w @epagoge/web build

# ---------- Stage 2: runtime (nginx) ----------
FROM nginx:1.27-alpine AS runtime

# Replace default config with one tuned for SPA + cache headers.
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Built bundle.
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

# nginx runs as the `nginx` user by default in this image; no extra USER step
# needed. Listens on :80 inside the container; the cloud LB terminates TLS
# and routes to this port.
EXPOSE 80

# Health-check: hit the SPA's index page. nginx serves it without any backend.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://localhost/ || exit 1

# nginx daemons-off keeps the process in the foreground (PID 1 stays nginx).
CMD ["nginx", "-g", "daemon off;"]
