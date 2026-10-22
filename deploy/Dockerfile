# syntax=docker/dockerfile:1.7
# Multi-stage build for the After Hours Burger game service and static client.
#
#   docker build -f deploy/Dockerfile --target server -t after-hours-game:VERSION .
#   docker build -f deploy/Dockerfile --target client-dist \
#     --build-arg VITE_REALTIME_URL=https://realtime.example.com --output type=local,dest=./client-dist .

ARG NODE_IMAGE=node:24.22.1-bookworm-slim

# ---- dependencies (all workspaces, including dev tooling for the build) -------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/data/package.json packages/data/
COPY packages/simulation/package.json packages/simulation/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
# Optional: behind a TLS-intercepting proxy, pass its CA with --secret id=npm_ca,src=/path/ca.pem
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=npm_ca,required=false \
    sh -c 'if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; npm ci --no-audit --no-fund'

# ---- compile shared packages, server and client ------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY database database
ARG VITE_REALTIME_URL=""
ENV VITE_REALTIME_URL=${VITE_REALTIME_URL}
RUN npm run build:packages \
 && npm run build -w @ahb/server \
 && npm run build -w @ahb/client \
 && node -e "import('@dimforge/rapier3d-compat').then(async (R) => { await R.default.init(); console.log('rapier', R.default.version()); })"

# ---- static client files for the host Nginx -----------------------------------------------------
FROM scratch AS client-dist
COPY --from=build /app/apps/client/dist/ /

# ---- production runtime: compiled JavaScript only, production dependencies only ----------------
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production \
    PORT=2567 \
    HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/database/migrations
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/data/package.json packages/data/
COPY packages/simulation/package.json packages/simulation/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=npm_ca,required=false \
    sh -c 'if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
      npm ci --omit=dev --no-audit --no-fund -w @ahb/server -w @ahb/data -w @ahb/simulation -w @ahb/protocol' \
 && rm -rf apps/client
COPY --from=build /app/packages/data/dist packages/data/dist
COPY --from=build /app/packages/simulation/dist packages/simulation/dist
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY database/migrations database/migrations
USER node
EXPOSE 2567
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:2567/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Rapier is initialised during startup; failure exits non-zero so the restart policy applies.
CMD ["node", "apps/server/dist/index.js"]
