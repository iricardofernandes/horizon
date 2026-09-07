# syntax=docker/dockerfile:1
#
# Build context is identity/ alone (ADR 0002). Needing a sibling's file breaks the
# build, which is the intended feedback.

# --- dependencies ------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build -------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run typecheck && npm run build

# --- production dependencies -------------------------------------------------
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
# tini reaps zombies and forwards signals, so graceful shutdown actually runs
RUN apk add --no-cache tini
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# non-root; node:alpine ships an unprivileged `node` user
USER node
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main/main.js"]
