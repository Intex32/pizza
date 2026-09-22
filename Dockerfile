# syntax=docker/dockerfile:1

# =========================================================================================
# Pizza Night
#
# Two stages. The first builds the browser bundle (which needs TypeScript, Vite and React);
# the second ships only what actually runs: Node, express, and the built files.
#
# Building inside the image rather than copying a dist from the host is deliberate - it is
# impossible to accidentally ship a stale or missing client this way.
#
# Node 24+ is REQUIRED, not a preference: the server runs TypeScript directly (native type
# stripping) and uses the built-in node:sqlite. That is also why there is no build toolchain
# here and no native module to compile for ARM - the image works on a Pi unchanged.
# =========================================================================================

# --- Stage 1: build the client -----------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Dependencies first, so editing source does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/
COPY test/ ./test/

# `npm run build` type-checks the whole project first, so a type error fails the image build
# rather than turning up on the night.
RUN npm run build


# --- Stage 2: the thing that actually runs ------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# express and nothing else.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# server/ carries schema.sql, which the app reads at boot - it is not optional.
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=build /app/client/dist ./client/dist

# The database lives here. It MUST be a mounted volume: anything written inside the image
# layer is destroyed the moment the container is replaced, which for this app means losing
# an evening of orders.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3001

# Uses Node's built-in fetch, so the image needs no curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]
