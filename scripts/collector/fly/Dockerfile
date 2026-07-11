# LiveOne collector hub (musher) — Fly.io WireGuard hub image.
# Build the bundle first (`npm run build:collector` → ./collector.cjs), then `fly deploy` from here.
FROM node:20-alpine

# wireguard-tools = wg + wg-quick; iproute2 = ip(8) for wg-quick; bash = wg-quick's interpreter.
# Kernel WireGuard needs no userspace datapath binary on Fly's Firecracker host.
RUN apk add --no-cache wireguard-tools iproute2 bash

WORKDIR /app

# Runtime dep only: modbus-serial (the collector bundle externalises it). --omit=optional skips the
# serialport native build — we speak Modbus over TCP only.
COPY package.json ./package.json
RUN npm install --omit=optional --no-audit --no-fund

# esbuild-bundled collector (built by `npm run build:collector`) + the hub entrypoint.
COPY collector.cjs ./collector.cjs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
