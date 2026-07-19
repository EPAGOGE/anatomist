# Local infrastructure

Postgres 16 + Redis 7 in Docker. Used by `apps/api` during development.

## Up / down

```bash
# from repo root
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml down

# also remove volumes (wipes the local database!)
docker compose -f infra/docker-compose.yml down -v
```

## Connection strings

Default credentials for local development only.

```
DATABASE_URL=postgres://epagoge:epagoge_dev@localhost:5432/epagoge
REDIS_URL=redis://localhost:6379
```

Put these in your `.env` at the repo root (gitignored).
