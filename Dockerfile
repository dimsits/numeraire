# syntax=docker/dockerfile:1
#
# Multi-stage build — DEV_PIPELINE.md Phase 0 task 0.5, ARCHITECTURE.md §19.1.
#
#   base         node:22-alpine, matching .nvmrc and package.json engines
#   deps         full dependency install, cached on the lockfile alone
#   development  hot-reloading tsx; the target Compose uses for api + worker
#   build        tsc + tsc-alias -> dist/
#   production   runtime dependencies only, non-root, dist/ only
#
# ADR-008: the API and worker are separate processes from the same image; the
# process is chosen by overriding the command, not by building two images.

# ── base ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app
# dumb-init reaps zombies and forwards SIGTERM, so the graceful-shutdown
# handlers in main-api.ts / main-worker.ts actually run under `docker stop`.
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production

# ── deps ──────────────────────────────────────────────────────────────────
# Only the manifest and lockfile are copied, so a source edit does not
# invalidate the dependency layer.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# ── development ───────────────────────────────────────────────────────────
# Compose mounts ./src over /app/src; everything else comes from the image.
FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY vitest.config.ts eslint.config.js .prettierrc .dependency-cruiser.js drizzle.config.ts ./
COPY scripts ./scripts
COPY src ./src
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "dev:api"]

# ── build ─────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
# Re-resolve dependencies without devDependencies for the runtime layer.
RUN npm ci --omit=dev

# ── production ────────────────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main-api.js"]
