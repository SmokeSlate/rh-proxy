# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
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

EXPOSE 3000
CMD ["npm", "start"]
