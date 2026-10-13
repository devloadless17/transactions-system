# syntax=docker/dockerfile:1.7

# ===== Stage 1: deps + build =====
FROM node:24-alpine AS builder
WORKDIR /repo

# pnpm + build tooling (Prisma engines, argon2 native bits)
RUN apk add --no-cache python3 make g++ libc6-compat openssl \
  && corepack enable && corepack prepare pnpm@10.33.3 --activate

# Copy workspace manifests first for max layer cache
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile --filter @app/api... --filter @app/db... --filter @app/shared...

# Now the sources
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @app/db generate \
 && pnpm --filter @app/db build \
 && pnpm --filter @app/shared build \
 && pnpm --filter @app/api build

# ===== Stage 2: runtime =====
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# openssl for the Prisma engines at runtime. pnpm (installed globally so it's on
# PATH for the non-root `node` user with no runtime download) so the one-shot
# deploy migrate container (docker-compose.prod.yml `migrate`, which reuses this
# image) can run `prisma migrate deploy`, rotate the RLS role password, and seed.
RUN apk add --no-cache openssl libc6-compat \
  && npm install -g pnpm@10.33.3

# Copy the whole built workspace. pnpm uses symlinks from each project's
# local node_modules into the root .pnpm store — preserve that structure
# by copying everything under /repo.
COPY --from=builder /repo /repo
WORKDIR /repo/apps/api

USER node
EXPOSE 3001
WORKDIR /repo/apps/api
# Read by the deploy before it stops this container: a release carrying this
# label drains on SIGTERM (finishes everything in flight, then exits on its own
# — src/common/http/graceful-drain.ts), so it is given up to 60s; an older one
# keeps the old 10s.
LABEL com.rivalpayments.graceful-drain="1"
# Safe to run BESIDE another release (blue/green, scripts/deploy/release.sh):
# its background work takes database leases (src/database/job-lease.service.ts)
# and it reports when Caddy's health check last passed. A release swap overlaps
# two versions only if BOTH carry this label; with an older one it never does.
LABEL com.rivalpayments.blue-green="1"
CMD ["node", "dist/main.js"]
