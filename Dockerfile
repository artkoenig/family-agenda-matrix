# syntax=docker/dockerfile:1
# The Matrix Source as a singleton plugin container (ADR-0001 of Family Agenda); Synapse and one
# bridge per Messenger run as its companions (see plugins.example.yml).
#   docker build -t family-agenda-matrix .
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build

# Node.js has not shipped Corepack since version 25, so it comes from npm. git fetches the kit.
RUN npm install --global corepack@0.36.0 && corepack enable \
  && apt-get update && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --store-dir /tmp/store \
  && rm -rf /tmp/store
COPY src ./src
# esbuild bundles the sources and all dependencies into one file: the image ships no node_modules.
RUN pnpm build

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
# The plugin's volume for the secrets, and below it one volume per companion for its configuration.
RUN mkdir -p /config/synapse /config/whatsapp && chown -R node /config

USER node
ENV PORT=8080
# The plugin talks only to its companions on its private network, so it needs no egress.
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
