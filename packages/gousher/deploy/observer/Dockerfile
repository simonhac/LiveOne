# Repository root is the build context. Build from a clean git archive.
FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/usher/package.json packages/usher/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY packages/telemetry ./packages/telemetry
COPY lib/telemetry ./lib/telemetry
COPY lib/collectors/reference-export.ts lib/collectors/trial-artifacts.ts lib/collectors/interval-comparison.ts ./lib/collectors/
COPY scripts/gousher/production-supervisor.ts ./scripts/gousher/production-supervisor.ts
RUN node --import tsx -e "require('./lib/telemetry/data-observer.ts'); require('./lib/telemetry/supervisor.ts'); require('@liveone/telemetry/runtime')"
CMD ["node", "--import", "tsx", "scripts/gousher/production-supervisor.ts", "/etc/gousher-observer.json"]
