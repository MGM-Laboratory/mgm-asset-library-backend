# =============================================================================
# MGM Asset Library — backend API image (multi-stage).
# Heavy worker tooling (Blender / ClamAV / ffmpeg) is NOT installed here; the
# Part 3 worker container ships separately with those dependencies baked in.
# =============================================================================

# ─── 1. Builder ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN pnpm install --no-frozen-lockfile

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts

RUN pnpm prisma generate \
 && pnpm build \
 && pnpm prune --prod

# ─── 2. Runtime ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-4000}/healthz || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
