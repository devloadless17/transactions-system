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

# The browser-facing API base is inlined into the client bundle at BUILD time
# (Next.js NEXT_PUBLIC_*), so it cannot be changed by a runtime env var. Pass a
# build arg for any non-localhost deployment (e.g. an HTTPS gateway origin).
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/v1
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

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
