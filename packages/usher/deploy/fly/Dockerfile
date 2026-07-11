# usher hub — Fly.io image: multi-peer WireGuard hub + cloudflared + the Next.js standalone server.
#
# BUILD CONTEXT = the repo root (the usher is an npm workspace and the standalone build traces the
# whole monorepo). Deploy from the repo root:
#   fly deploy -c packages/usher/deploy/fly/fly.toml --dockerfile packages/usher/deploy/fly/Dockerfile

# ── stage 1: build the Next.js standalone (monorepo) ──
FROM node:22-alpine AS builder
WORKDIR /repo
# Install with the full workspace manifest set so npm links @liveone/protocol ⇄ @liveone/usher.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/usher/package.json packages/usher/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run --workspace @liveone/usher build

# ── stage 2: runtime ──
FROM node:22-alpine AS runner
# wireguard-tools = wg + wg-quick; iproute2 = ip(8); bash = wg-quick interpreter; curl/ca-certs for
# fetching cloudflared. Kernel WireGuard needs no userspace binary on Fly's Firecracker host.
RUN apk add --no-cache wireguard-tools iproute2 bash ca-certificates curl \
 && case "$(uname -m)" in x86_64) CF=amd64;; aarch64) CF=arm64;; *) CF=amd64;; esac \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF}" \
      -o /usr/local/bin/cloudflared \
 && chmod +x /usr/local/bin/cloudflared

WORKDIR /app
ENV NODE_ENV=production
# Standalone server (monorepo layout → /app/packages/usher/server.js) + the static assets.
COPY --from=builder /repo/packages/usher/.next/standalone ./
COPY --from=builder /repo/packages/usher/.next/static ./packages/usher/.next/static

# Baked default config (non-secret; hosts only). For a real deployment, replace usher.example.yaml's
# hosts (or bake a real packages/usher/usher.yaml and COPY it here). Secrets come via env (apiKeyEnv).
COPY packages/usher/usher.example.yaml /app/usher.yaml
ENV USHER_CONFIG=/app/usher.yaml
# Bind to localhost only — cloudflared fronts the inspector; nothing public on the Fly HTTP port.
ENV HOSTNAME=127.0.0.1
ENV PORT=3000

COPY packages/usher/deploy/fly/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
