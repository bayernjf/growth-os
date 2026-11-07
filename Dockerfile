# growth-os self-hosted image, modelled on the growth-agent / model-hub
# Tier 0 templates: multi-stage Node 22 build, production-only runner, non-root
# `node` user, named volume for the SQLite file, /healthz liveness probe.
#
# growth-os depends on two sibling packages through file: paths
# (zeus-client and @model-hub/model-kit). They are supplied as named build
# contexts so the image build never needs a full checkout of those repos:
#   docker build \
#     --build-context zeusclient=../zeus/packages/zeus-client \
#     --build-context modelkit=../model-hub/packages/model-kit \
#     -t growth-os:local .
# docker-compose.yml wires the same contexts automatically.

# ---- builder: install full deps, build the file: packages, compile TS ----
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=zeusclient ./ /zeus/packages/zeus-client/
COPY --from=modelkit ./ /model-hub/packages/model-kit/

# --ignore-scripts: model-kit's prepare hook would run tsc before the
# dependency tree is linked; both packages are built explicitly below instead.
RUN npm ci --ignore-scripts

# The sibling packages publish dist/ through their exports, so compile them
# before growth-os. Link node_modules into each package so their tsconfigs
# resolve @types/node and @types/ws from this install. ws/@types/ws are pinned
# to the versions in model-hub's lockfile (8.22.0 / 8.18.2).
RUN ln -s /app/node_modules /zeus/packages/zeus-client/node_modules \
 && ln -s /app/node_modules /model-hub/packages/model-kit/node_modules \
 && npm install --no-save --ignore-scripts --no-audit --no-fund ws@8.22.0 @types/ws@8.18.2 \
 && ./node_modules/.bin/tsc -p /model-hub/packages/model-kit/tsconfig.build.json \
 && ./node_modules/.bin/tsc -p /zeus/packages/zeus-client/tsconfig.json

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runner: production dependencies only, non-root ----
# Migrations ship with the image: dist/serve.js calls migrateUp before it
# starts listening, so 015_order_number_sequence_repair and any future
# migration apply on boot. There is no separate migration step in the stack.
FROM node:22-slim AS runner
ENV NODE_ENV=production \
    GROWTH_HOST=0.0.0.0 \
    GROWTH_PORT=8788 \
    GROWTH_DB_DRIVER=sqlite \
    GROWTH_SQLITE_PATH=/data/growth-os.db
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /zeus/packages/zeus-client /zeus/packages/zeus-client
COPY --from=builder /model-hub/packages/model-kit /model-hub/packages/model-kit
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
# Paired migrations are read at runtime from db/migrations (src/storage/migrate.ts).
COPY --chown=node:node db ./db
# Offline search fixtures: the default GROWTH_SEARCH_MODE=offline replays these.
COPY --chown=node:node recordings ./recordings
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GROWTH_PORT||8788)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# node:sqlite is still behind the experimental flag on Node 22.
CMD ["node", "--experimental-sqlite", "dist/serve.js"]
