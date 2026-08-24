# ── Build stage

FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --production

# ── Runtime stage
FROM node:22-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/dist         ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Migrations must be available at runtime for the release_command
COPY --from=builder --chown=appuser:appgroup /app/src/db/migrations ./dist/db/migrations

USER appuser

EXPOSE 3000
# Liveness check — lightweight, no DB/Redis dependency
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

  CMD ["node", "dist/server.js"]
