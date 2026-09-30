# syntax=docker/dockerfile:1
#
# Build context is web/ alone (ADR 0002).

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run typecheck && npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache tini
WORKDIR /app

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/trusted-address.cjs ./

USER node
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
# The browser's address is set before Next reads the request (Phase 80).
CMD ["node", "--require", "./trusted-address.cjs", "server.js"]
