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

# Need openssl for the Prisma engines at runtime
RUN apk add --no-cache openssl libc6-compat

# Copy the whole built workspace. pnpm uses symlinks from each project's
# local node_modules into the root .pnpm store — preserve that structure
# by copying everything under /repo.
COPY --from=builder /repo /repo
WORKDIR /repo/apps/api

USER node
EXPOSE 3001
WORKDIR /repo/apps/api
CMD ["node", "dist/main.js"]
