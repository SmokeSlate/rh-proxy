FROM node:22-bookworm-slim AS deps
WORKDIR /app

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    HOST=0.0.0.0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r pptruser \
  && useradd -r -m -g pptruser -G audio,video pptruser

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./

USER pptruser

EXPOSE 8080
CMD ["node", "server.js"]
