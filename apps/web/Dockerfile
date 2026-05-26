# syntax=docker/dockerfile:1.7

# ===== Stage 1: build =====
FROM node:24-alpine AS builder
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
  && corepack enable && corepack prepare pnpm@10.33.3 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @app/web... --filter @app/shared...

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN pnpm --filter @app/shared build \
 && pnpm --filter @app/web build

# ===== Stage 2: runtime =====
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Next.js standalone server bundles everything it needs.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
