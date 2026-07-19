# DEPLOYMENT.md

Single-region deployment runbook for the EPAGOGE platform. Provider-agnostic: works on any platform that runs Docker containers (AWS Fargate/ECS, GCP Cloud Run, Azure Container Apps, Fly.io machines, DigitalOcean App Platform, Hetzner CX-series + Docker, bare-metal VPS).

Scope governor (per F-0 Criterion 10): **single-region, minimal, genuinely-deployed-and-reachable.** NOT multi-region. NOT autoscaling. NOT production-hardened. Pair-this-with-monitoring is left for a follow-up — what's here covers "the platform is up and a real user can register, save an architecture, and see it chained."

---

## What gets deployed

Three containers + two managed dependencies:

| Container       | Image                | Role                                                                 |
| --------------- | -------------------- | -------------------------------------------------------------------- |
| `web` (nginx)   | `epagoge-web:latest` | Serves the React SPA + optionally proxies `/api/*` to the api        |
| `api` (Fastify) | `epagoge-api:latest` | Every backend route + chain emissions + AI orchestration             |
| `migrate` (api) | `epagoge-api:latest` | One-shot drizzle-kit migration; runs once per deploy, NOT continuous |

| Dependency  | Self-hosted option (single-node) | Managed option (recommended for prod)   |
| ----------- | -------------------------------- | --------------------------------------- |
| Postgres 16 | `postgres:16-alpine` container   | RDS / Cloud SQL / Azure Database / Neon |
| Redis 7     | `redis:7-alpine` container       | ElastiCache / Memorystore / Upstash     |

Source of truth for the orchestration: `infra/docker-compose.prod.yml`. For platforms that don't accept docker-compose directly, translate the spec — every service, env var, and dependency is named explicitly there.

---

## Pre-deploy checklist

Before the first deploy, you need:

- A container registry to push images to (Docker Hub, ECR, GHCR, GCR, ACR, etc.).
- A target deployment platform (see "Provider notes" below).
- A Postgres instance — managed or self-hosted; version 16+ recommended.
- A Redis instance — managed or self-hosted; version 7+ recommended.
- Strong secrets for `JWT_SECRET` and `MASTER_ENCRYPTION_KEY` (32 bytes each, hex-encoded):
  ```bash
  openssl rand -hex 32   # use this twice — once per secret
  ```
- An Anthropic API key (`ANTHROPIC_API_KEY`) — without it, AI features fail closed but everything else still works.
- A domain (optional but recommended) + TLS termination at your load balancer.

---

## Deploy procedure

### Step 1 — Configure secrets

Copy the example env file and fill in real values:

```bash
cp infra/.env.production.example infra/.env.production
# Edit infra/.env.production with the secrets generated above
```

Required (will fail to start without them):

- `POSTGRES_PASSWORD` — strong DB password
- `JWT_SECRET` — 64-char hex (32 bytes)
- `MASTER_ENCRYPTION_KEY` — 64-char hex (32 bytes); **do not rotate without a key-rotation plan**

Recommended:

- `ANTHROPIC_API_KEY` — required for AI features
- `VITE_API_BASE_URL` — where the SPA points its API calls

Optional overrides:

- `DATABASE_URL` — when using managed Postgres
- `REDIS_URL` — when using managed Redis
- `WEB_PORT` — host port for the web service (default 8080)

### Step 2 — Build images

```bash
docker compose -f infra/docker-compose.prod.yml build
```

This builds two images: `epagoge-api:latest` and `epagoge-web:latest`. The build uses the monorepo root as context, so all workspace packages get bundled correctly.

For a registry push, tag and push after the build:

```bash
docker tag epagoge-api:latest <registry>/epagoge-api:<version>
docker tag epagoge-web:latest <registry>/epagoge-web:<version>
docker push <registry>/epagoge-api:<version>
docker push <registry>/epagoge-web:<version>
```

### Step 3 — Run migrations

Migrations are a **separate step**, NOT part of the api container's entrypoint. This is deliberate: multi-instance deploys would race on shared migrations, and migration failure should be a deploy-time signal rather than a runtime crash loop.

```bash
docker compose -f infra/docker-compose.prod.yml run --rm migrate
```

The `migrate` service is profiled under `tools` — it won't start with a plain `up`. Re-run this step whenever new migrations are added (`apps/api/drizzle/*.sql`).

### Step 4 — Start the services

```bash
docker compose -f infra/docker-compose.prod.yml up -d
```

The web service will be reachable on `http://localhost:${WEB_PORT}` (default 8080). The api isn't exposed on the host directly — it's reachable from the web container's nginx via the internal docker network.

### Step 5 — Verify health

```bash
# Liveness (process running)
curl http://localhost:8080/api/health/live
# Expected: {"status":"ok"}

# Readiness (dependencies reachable)
curl http://localhost:8080/api/health/ready
# Expected: {"status":"ready","checks":[...]}
```

If `/health/ready` returns 503, the response body lists which dependency check failed. Common failures:

- `postgres` — `DATABASE_URL` wrong, password wrong, or instance unreachable
- `redis` — `REDIS_URL` wrong or instance unreachable

### Step 6 — Seed reasoning-capture chain

Optional but recommended for a fresh deploy — seeds every ADR as a signed chain event:

```bash
docker compose -f infra/docker-compose.prod.yml exec api \
  node apps/api/dist/scripts/seed-reasoning-chain.js
```

(Or run from outside the cluster with the production DATABASE_URL pointing at the same DB.)

---

## TLS termination

Two patterns work; pick based on what your platform offers:

**Pattern A — TLS at the cloud load balancer.** Most cloud-managed container platforms (Cloud Run, App Runner, Container Apps) terminate TLS at the platform's LB and forward plain HTTP to your container. The web container's nginx config already trusts the upstream LB; no changes needed.

**Pattern B — TLS in a sidecar.** For bare-metal or single-VM deploys, add a Traefik or Caddy sidecar in front of the web container. Both can do Let's Encrypt automatically. Sample addition to `infra/docker-compose.prod.yml`:

```yaml
traefik:
  image: traefik:v3.1
  command:
    - --providers.docker=true
    - --providers.docker.exposedbydefault=false
    - --entrypoints.web.address=:80
    - --entrypoints.websecure.address=:443
    - --certificatesresolvers.le.acme.email=ops@your-domain
    - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    - --certificatesresolvers.le.acme.tlschallenge=true
  ports:
    - '80:80'
    - '443:443'
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - letsencrypt:/letsencrypt
```

Then add Traefik labels to the `web` service for the cert + routing rules.

---

## Provider notes

### AWS

- **ECS Fargate + RDS Postgres + ElastiCache Redis.** Translate each service in `docker-compose.prod.yml` to an ECS task definition; use Secrets Manager for `JWT_SECRET` + `MASTER_ENCRYPTION_KEY`; put the web tasks behind an ALB with ACM-issued TLS.
- **Alternative — Lightsail Containers.** Accepts docker-compose directly; smaller deploys land in under an hour. Use the managed Postgres add-on or a separate RDS instance.

### GCP

- **Cloud Run + Cloud SQL + Memorystore.** Each container becomes a Cloud Run service; the migration step is a Cloud Run Job; secrets go in Secret Manager. Cloud Run terminates TLS automatically and assigns each service a `*.run.app` URL.
- **Alternative — GKE Autopilot.** Heavier than Cloud Run but supports more complex networking; use this if you outgrow Cloud Run's limits.

### Azure

- **Container Apps + Azure Database for PostgreSQL Flexible + Azure Cache for Redis.** Container Apps consumes a YAML spec close to the compose shape; use Key Vault for secrets; TLS is automatic on the assigned `*.azurecontainerapps.io` URL.

### Self-hosted (Hetzner / DigitalOcean / Linode / etc.)

- Single VM with Docker + `infra/docker-compose.prod.yml` as-is. Add the Traefik sidecar for TLS. Back up the `pgdata` volume daily.
- Use the managed Postgres + managed Redis add-ons from the provider rather than self-hosting them in the same VM — disk corruption on a single VM eats both app and data.

---

## Monitoring (the minimum)

Per the scope governor, the deploy doesn't include production-grade observability. The minimum that's already in place + the next steps to take:

**Already in place:**

- Pino structured logs on every request (JSON; ready for any log aggregator).
- `/health/live` + `/health/ready` endpoints for platform probes.
- Every chain emission is itself a self-attesting log of "what happened" — the reasoning-capture and system-operational chains are queryable forensic records.
- Cost-tracking on every AI interaction (`/ai/cost-stats` endpoint).

**Next steps (out of scope for F-0 but worth recording):**

- Push pino logs to a managed log service (Datadog, Honeycomb, CloudWatch Logs, Cloud Logging, Loki).
- Add a `/metrics` endpoint (prometheus-format) — Fastify has `fastify-metrics`; not yet wired.
- Alert on `/health/ready` returning 503 for >1 minute.
- Alert on AI cost-stats exceeding a configured daily budget.
- Track chain-emission failures (currently they surface as 500s with a specific error code; aggregate them).

---

## Rollback

If a deploy goes bad:

1. **Roll back containers:** `docker compose -f infra/docker-compose.prod.yml up -d --no-deps api web` with the previous image tag. Chain emissions are append-only — old code reads new events fine (events are forward-compatible per ADR-0001).
2. **DO NOT roll back migrations** unless the previous schema is explicitly known-compatible. Drizzle migrations are forward-only; reverting requires a hand-written down migration that the team hasn't built. The safer pattern is to ship a fix-forward migration.
3. **Restore from backup** is the last resort for DB corruption. Set up automated backups (RDS automated snapshots, Cloud SQL backups, etc.) before this matters.

---

## Smoke test after deploy

A real user-flow smoke test that doesn't require browser automation:

```bash
# Set this to your deployed URL
BASE="http://localhost:8080/api"

# 1. Register a user
curl -s -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke@example.com","password":"strong-password-12345","display_name":"Smoke"}' \
  | tee /tmp/reg.json
TOKEN=$(jq -r .access_token /tmp/reg.json)

# 2. Create a project
curl -s -X POST "$BASE/projects" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke project"}' \
  | tee /tmp/proj.json

# 3. List chains
curl -s "$BASE/chains" -H "Authorization: Bearer $TOKEN"

# 4. Ready check (should be all-ok)
curl -s "$BASE/health/ready" | jq .
```

If steps 1-3 succeed and step 4 returns `status: ready`, the deploy is functional. The platform's distinctive features (canvas save, code export) require browser-driven testing for the canvas piece; the API smoke covers the chain-side trust path.

---

## Disciplines this deploy honors

Carried over from BUILD_RAILS.md's rail-keepers — no new disciplines introduced by deploy:

- **User-scoped credentials (#16):** `MASTER_ENCRYPTION_KEY` is a server secret, NEVER a per-user credential. Per-user secrets (HF tokens, GitHub PATs) remain per-request, never persisted server-side.
- **Hybrid signing:** the platform identity (loaded via `ensureLocalIdentity`) signs chain events with BOTH Ed25519 and ML-DSA-65; this works identically in dev and prod.
- **AI off the reliability path (ADR-0008):** the api will start and serve all non-AI features even if `ANTHROPIC_API_KEY` is missing. AI routes return clear errors; non-AI routes are unaffected.
- **External-API chokepoint (#11):** every outbound HTTP call routes through `apps/api/src/external/http.ts`. The rate-limit buckets (HF: per-process; GitHub: 1 req/sec) are in-process; for multi-instance deploys the buckets won't coordinate, which is acceptable for F-0 single-region scope.
- **No clock ordering (ADR-0007):** chain ordering uses causal predecessors + monotonic markers. Wall-clock skew between deploy instances or NTP drift does NOT corrupt chain integrity.
